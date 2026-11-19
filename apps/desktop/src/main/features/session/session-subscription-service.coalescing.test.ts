import { afterEach, describe, expect, it, vi } from "vitest"
import { EventEmitter, on } from "node:events"
import type { SessionEventRecord, SessionStateSnapshot } from "@rzx/client"

import { SessionSubscriptionService } from "./session-subscription-service"
import { visibleTranscriptParts } from "../../../renderer/src/components/desktop/conversation-page/transcript/transcript-visibility"
import type {
  DesktopSessionUpdate,
  DesktopSessionUpdateAck,
  DesktopSessionResyncRequest,
} from "../../../shared/session-types"

const session = {
  id: "s1",
  cwd: "D:/repo",
  title: "s1",
  model: "m",
  status: "idle" as const,
  metadata: { desktop: { workspaceMode: "outside_project" } },
  createdAt: 1,
  updatedAt: 1,
}

function snapshot(cursor: number): SessionStateSnapshot {
  return {
    cursor,
    session,
    inputs: [],
    messages: [],
    parts: [],
    runs: [],
    attempts: [],
    permissions: [],
  } as SessionStateSnapshot
}

function sessionUpdated(seq: number): SessionEventRecord {
  return {
    id: `e${seq}`,
    seq,
    type: "session.updated",
    schemaVersion: 1,
    sessionId: "s1",
    payload: { session: { ...session, updatedAt: seq } },
    createdAt: seq,
  } as SessionEventRecord
}

function sessionDeleted(seq: number): SessionEventRecord {
  return {
    id: `e${seq}`,
    seq,
    type: "session.deleted",
    schemaVersion: 1,
    sessionId: "s1",
    payload: { sessionIds: ["s1"] },
    createdAt: seq,
  } as SessionEventRecord
}

function clientWithStream(stream: () => AsyncIterable<SessionEventRecord>) {
  return {
    sessions: { getState: vi.fn(async () => snapshot(1)) },
    events: { list: vi.fn(async () => []), stream: vi.fn(stream) },
  }
}

function webContents() {
  const sent: Array<{ channel: string; payload: unknown }> = []
  let destroyed = false
  const contents = {
    id: 77,
    once: vi.fn(),
    isDestroyed: () => destroyed,
    send: vi.fn((channel: string, payload: unknown) => {
      sent.push({ channel, payload })
    }),
  }
  return { contents, sent, destroy: () => { destroyed = true } }
}

afterEach(() => {
  vi.useRealTimers()
})

describe("SessionSubscriptionService coalescing", () => {
  it("invalidates workflows when the first run starts in an empty session stream", async () => {
    vi.useFakeTimers()
    const client = clientWithStream(async function* () {
      yield { ...sessionUpdated(2), type: "workflow.workflow_started", payload: { event: { runId: "new-workflow" } } }
      await new Promise<never>(() => undefined)
    })
    const { contents, sent } = webContents()
    const service = new SessionSubscriptionService({ sessionUpdateIntervalMs: 50 })
    try {
      await service.openSession(client as never, contents as never, "s1")
      await vi.advanceTimersByTimeAsync(51)
      expect(sent[0]?.payload).toMatchObject({ kind: "snapshot", view: { workflowRevision: 2 } })
    } finally { service.clearAll() }
  })
  it("turns an isolated usage event into the existing snapshot delivery after ACK", async () => {
    vi.useFakeTimers();
    const stream = new EventEmitter();
    const client = clientWithStream(async function* () {
      for await (const [value] of on(stream, "event")) yield value as SessionEventRecord;
    });
    const { contents, sent } = webContents();
    const service = new SessionSubscriptionService({ sessionUpdateIntervalMs: 50 });
    await service.openSession(client as never, contents as never, "s1");
    await vi.advanceTimersByTimeAsync(1);
    stream.emit("event", sessionUpdated(2));
    await vi.advanceTimersByTimeAsync(50);
    const first = sent[0]!.payload as DesktopSessionUpdate;
    stream.emit("event", { ...sessionUpdated(3), type: "session.goal.usage.updated", payload: { goalId: "g1", usage: { knownTokens: 12, incomplete: false, unknownAttempts: 0, partialAttempts: 0, inFlightAttempts: 0, runTimeMs: 0, seq: 1, updatedAt: 3 } } });
    await vi.advanceTimersByTimeAsync(50);
    expect(sent).toHaveLength(1);
    service.acknowledgeUpdate(contents.id, { subscriptionId: first.subscriptionId, generation: first.generation, deliveryId: first.deliveryId, result: "applied" });
    await vi.advanceTimersByTimeAsync(50);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.payload).toMatchObject({ kind: "snapshot", view: { cursor: 3 } });
    service.clearAll();
    stream.emit("event", sessionUpdated(4));
  });
  it("does not rebuild owner snapshots for each text delta while delivering the complete coalesced text", async () => {
    vi.useFakeTimers()
    const client = {
      sessions: { getState: async () => snapshot(1) },
      events: {
        list: async () => [],
        stream: async function* (options: { signal: AbortSignal }) {
          for (let seq = 2; seq <= 101; seq++) {
            yield {
              id: `delta-${seq}`,
              seq,
              type: "session.message.part.delta",
              schemaVersion: 1,
              sessionId: "s1",
              createdAt: seq,
              payload: {
                sessionId: "s1",
                messageId: "m1",
                partId: "p1",
                field: "text",
                delta: "x",
              },
            } satisfies SessionEventRecord
          }
          await new Promise<void>((resolve) => {
            if (options.signal.aborted) resolve()
            else options.signal.addEventListener("abort", () => resolve(), { once: true })
          })
        },
      },
    }
    const { contents, sent } = webContents()
    const service = new SessionSubscriptionService({ sessionUpdateIntervalMs: 50 })
    let observed = 0
    service.onOwnerSnapshot(() => {
      observed++
    })
    try {
      await service.openSession(client as never, contents as never, "s1")
      await vi.advanceTimersByTimeAsync(1)
      expect(observed).toBe(1)
      expect(sent).toHaveLength(0)
      await vi.advanceTimersByTimeAsync(50)
      expect(sent).toHaveLength(1)
      const update = sent[0]!.payload as DesktopSessionUpdate
      expect(update.kind).toBe("part-delta")
      if (update.kind !== "part-delta") throw new Error("expected part delta delivery")
      expect(update.deltas).toHaveLength(100)
      expect(update.deltas[0]).toMatchObject({ baseLength: 0, delta: "x", seq: 2 })
      expect(update.deltas.at(-1)).toMatchObject({ baseLength: 99, delta: "x", seq: 101 })
      expect(observed).toBe(1)
    } finally {
      service.clearAll()
      await vi.advanceTimersByTimeAsync(0)
    }
  })

  it("keeps one live delivery in flight until the renderer acknowledges it", async () => {
    vi.useFakeTimers()
    let releaseNext!: () => void
    const nextEvent = new Promise<void>((resolve) => { releaseNext = resolve })
    const client = clientWithStream(async function* () {
      const createDelta = (seq: number, delta: string): SessionEventRecord => ({
        id: `delta-${seq}`,
        seq,
        type: "session.message.part.delta",
        schemaVersion: 1,
        sessionId: "s1",
        createdAt: seq,
        payload: {
          sessionId: "s1",
          messageId: "m1",
          partId: "p1",
          field: "text",
          delta,
        },
      })
      yield createDelta(2, "a")
      await nextEvent
      yield createDelta(3, "b")
      await new Promise<never>(() => undefined)
    })
    const { contents, sent } = webContents()
    const service = new SessionSubscriptionService({ sessionUpdateIntervalMs: 50 })

    try {
      await service.openSession(client as never, contents as never, "s1")
      await vi.advanceTimersByTimeAsync(1)
      await vi.advanceTimersByTimeAsync(50)
      expect(sent).toHaveLength(1)

      releaseNext()
      await vi.advanceTimersByTimeAsync(1)
      await vi.advanceTimersByTimeAsync(50)
      expect(sent).toHaveLength(1)

      const first = sent[0]!.payload as DesktopSessionUpdate
      expect(service.acknowledgeUpdate(contents.id, {
        subscriptionId: first.subscriptionId,
        generation: first.generation,
        deliveryId: first.deliveryId,
        result: "unknown",
      } as never)).toEqual({ accepted: false })
      const ack: DesktopSessionUpdateAck = {
        subscriptionId: first.subscriptionId,
        generation: first.generation,
        deliveryId: first.deliveryId,
        result: "applied",
      }
      expect(service.acknowledgeUpdate(contents.id, {
        ...ack,
        subscriptionId: "primary:stale",
      })).toEqual({ accepted: false })
      expect(service.acknowledgeUpdate(contents.id + 1, ack)).toEqual({ accepted: false })
      expect(service.acknowledgeUpdate(contents.id, ack)).toEqual({ accepted: true })
      expect(sent).toHaveLength(2)
      const second = sent[1]!.payload as DesktopSessionUpdate
      expect(second.kind).toBe("part-delta")
      if (second.kind !== "part-delta") throw new Error("expected buffered delta delivery")
      expect(second.deltas).toMatchObject([{ baseLength: 1, delta: "b", seq: 3 }])
      expect(service.acknowledgeUpdate(contents.id, {
        subscriptionId: second.subscriptionId,
        generation: second.generation,
        deliveryId: second.deliveryId,
        result: "applied",
      })).toEqual({ accepted: true })
      const duplicateWatchdogRequest: DesktopSessionResyncRequest = {
        subscriptionId: first.subscriptionId,
        generation: first.generation,
        deliveryId: first.deliveryId,
        lastAppliedDeliveryId: first.deliveryId,
      }
      expect(service.requestUpdateResync(contents.id, duplicateWatchdogRequest)).toEqual({
        accepted: true,
      })
      expect(sent).toHaveLength(2)
    } finally {
      service.clearAll()
      await vi.advanceTimersByTimeAsync(0)
    }
  })

  it("supersedes a timed-out delivery with the latest snapshot and rejects its late ACK", async () => {
    vi.useFakeTimers()
    const client = clientWithStream(async function* () {
      yield {
        id: "delta-2",
        seq: 2,
        type: "session.message.part.delta",
        schemaVersion: 1,
        sessionId: "s1",
        createdAt: 2,
        payload: {
          sessionId: "s1",
          messageId: "m1",
          partId: "p1",
          field: "text",
          delta: "latest",
        },
      } satisfies SessionEventRecord
      await new Promise<never>(() => undefined)
    })
    const { contents, sent } = webContents()
    const service = new SessionSubscriptionService({ sessionUpdateIntervalMs: 50 })

    try {
      await service.openSession(client as never, contents as never, "s1")
      await vi.advanceTimersByTimeAsync(51)
      expect(sent).toHaveLength(1)
      const timedOut = sent[0]!.payload as DesktopSessionUpdate
      const request: DesktopSessionResyncRequest = {
        subscriptionId: timedOut.subscriptionId,
        generation: timedOut.generation,
        deliveryId: timedOut.deliveryId,
        lastAppliedDeliveryId: null,
      }
      expect(service.requestUpdateResync(contents.id, request)).toEqual({ accepted: true })
      expect(sent).toHaveLength(2)
      const recovery = sent[1]!.payload as DesktopSessionUpdate
      expect(recovery.kind).toBe("snapshot")
      expect(recovery.generation).toBeGreaterThan(timedOut.generation)
      if (recovery.kind !== "snapshot") throw new Error("expected recovery snapshot")
      expect(recovery.view.parts[0]?.text).toBe("latest")
      expect(service.acknowledgeUpdate(contents.id, {
        subscriptionId: timedOut.subscriptionId,
        generation: timedOut.generation,
        deliveryId: timedOut.deliveryId,
        result: "applied",
      })).toEqual({ accepted: false })
    } finally {
      service.clearAll()
      await vi.advanceTimersByTimeAsync(0)
    }
  })

  it("replaces an update after the renderer reports that it could not apply it", async () => {
    vi.useFakeTimers()
    const client = clientWithStream(async function* () {
      yield {
        id: "delta-2",
        seq: 2,
        type: "session.message.part.delta",
        schemaVersion: 1,
        sessionId: "s1",
        createdAt: 2,
        payload: {
          sessionId: "s1",
          messageId: "m1",
          partId: "p1",
          field: "text",
          delta: "authoritative",
        },
      } satisfies SessionEventRecord
      await new Promise<never>(() => undefined)
    })
    const { contents, sent } = webContents()
    const service = new SessionSubscriptionService({ sessionUpdateIntervalMs: 50 })

    try {
      await service.openSession(client as never, contents as never, "s1")
      await vi.advanceTimersByTimeAsync(51)
      const failedDelivery = sent[0]!.payload as DesktopSessionUpdate
      expect(service.acknowledgeUpdate(contents.id, {
        subscriptionId: failedDelivery.subscriptionId,
        generation: failedDelivery.generation,
        deliveryId: failedDelivery.deliveryId,
        result: "resync-required",
      })).toEqual({ accepted: true })
      const recovery = sent[1]!.payload as DesktopSessionUpdate
      expect(recovery.kind).toBe("snapshot")
      expect(recovery.generation).toBeGreaterThan(failedDelivery.generation)
      if (recovery.kind !== "snapshot") throw new Error("expected application recovery snapshot")
      expect(recovery.view.syncStatus).toBe("connected")
      expect(recovery.view.parts[0]?.text).toBe("authoritative")
    } finally {
      service.clearAll()
      await vi.advanceTimersByTimeAsync(0)
    }
  })

  it("replaces an oversized pending delta batch with one latest snapshot", async () => {
    vi.useFakeTimers()
    let releaseBurst!: () => void
    const burst = new Promise<void>((resolve) => { releaseBurst = resolve })
    const client = clientWithStream(async function* () {
      const createDelta = (seq: number): SessionEventRecord => ({
        id: `delta-${seq}`,
        seq,
        type: "session.message.part.delta",
        schemaVersion: 1,
        sessionId: "s1",
        createdAt: seq,
        payload: {
          sessionId: "s1",
          messageId: "m1",
          partId: "p1",
          field: "text",
          delta: "x",
        },
      })
      yield createDelta(2)
      await burst
      for (let seq = 3; seq <= 503; seq++) yield createDelta(seq)
      await new Promise<never>(() => undefined)
    })
    const { contents, sent } = webContents()
    const service = new SessionSubscriptionService({ sessionUpdateIntervalMs: 50 })

    try {
      await service.openSession(client as never, contents as never, "s1")
      await vi.advanceTimersByTimeAsync(51)
      const first = sent[0]!.payload as DesktopSessionUpdate
      expect(first.kind).toBe("part-delta")

      releaseBurst()
      await vi.advanceTimersByTimeAsync(51)
      expect(sent).toHaveLength(1)
      expect(service.acknowledgeUpdate(contents.id, {
        subscriptionId: first.subscriptionId,
        generation: first.generation,
        deliveryId: first.deliveryId,
        result: "applied",
      })).toEqual({ accepted: true })

      expect(sent).toHaveLength(2)
      const recovery = sent[1]!.payload as DesktopSessionUpdate
      expect(recovery.kind).toBe("snapshot")
      if (recovery.kind !== "snapshot") throw new Error("expected overflow recovery snapshot")
      expect(recovery.view.cursor).toBe(503)
      expect(recovery.view.parts[0]?.text).toBe("x".repeat(502))
    } finally {
      service.clearAll()
      await vi.advanceTimersByTimeAsync(0)
    }
  })

  it("replaces pending deltas above the byte budget with a latest snapshot", async () => {
    vi.useFakeTimers()
    let releaseLargeDelta!: () => void
    const largeDelta = new Promise<void>((resolve) => { releaseLargeDelta = resolve })
    const client = clientWithStream(async function* () {
      const createDelta = (seq: number, delta: string): SessionEventRecord => ({
        id: `delta-${seq}`,
        seq,
        type: "session.message.part.delta",
        schemaVersion: 1,
        sessionId: "s1",
        createdAt: seq,
        payload: {
          sessionId: "s1",
          messageId: "m1",
          partId: "p1",
          field: "text",
          delta,
        },
      })
      yield createDelta(2, "x")
      await largeDelta
      yield createDelta(3, "y".repeat(1024 * 1024))
      await new Promise<never>(() => undefined)
    })
    const { contents, sent } = webContents()
    const service = new SessionSubscriptionService({ sessionUpdateIntervalMs: 50 })

    try {
      await service.openSession(client as never, contents as never, "s1")
      await vi.advanceTimersByTimeAsync(51)
      const first = sent[0]!.payload as DesktopSessionUpdate
      releaseLargeDelta()
      await vi.advanceTimersByTimeAsync(51)
      expect(sent).toHaveLength(1)
      expect(service.acknowledgeUpdate(contents.id, {
        subscriptionId: first.subscriptionId,
        generation: first.generation,
        deliveryId: first.deliveryId,
        result: "applied",
      })).toEqual({ accepted: true })

      const recovery = sent[1]!.payload as DesktopSessionUpdate
      expect(recovery.kind).toBe("snapshot")
      if (recovery.kind !== "snapshot") throw new Error("expected byte-limit snapshot")
      expect(recovery.view.parts[0]?.text?.length).toBe(1024 * 1024 + 1)
      expect(recovery.view.cursor).toBe(3)
    } finally {
      service.clearAll()
      await vi.advanceTimersByTimeAsync(0)
    }
  })

  it("discards pending deltas when a structural update arrives and recovers latest state", async () => {
    vi.useFakeTimers()
    let releaseStructure!: () => void
    const structure = new Promise<void>((resolve) => { releaseStructure = resolve })
    const client = clientWithStream(async function* () {
      yield {
        id: "delta-2",
        seq: 2,
        type: "session.message.part.delta",
        schemaVersion: 1,
        sessionId: "s1",
        createdAt: 2,
        payload: {
          sessionId: "s1",
          messageId: "m1",
          partId: "p1",
          field: "text",
          delta: "x",
        },
      } satisfies SessionEventRecord
      await structure
      yield {
        id: "session-3",
        seq: 3,
        type: "session.updated",
        schemaVersion: 1,
        sessionId: "s1",
        createdAt: 3,
        payload: { session: { ...session, title: "latest title", updatedAt: 3 } },
      } satisfies SessionEventRecord
      await new Promise<never>(() => undefined)
    })
    const { contents, sent } = webContents()
    const service = new SessionSubscriptionService({ sessionUpdateIntervalMs: 50 })

    try {
      await service.openSession(client as never, contents as never, "s1")
      await vi.advanceTimersByTimeAsync(51)
      const first = sent[0]!.payload as DesktopSessionUpdate
      releaseStructure()
      await vi.advanceTimersByTimeAsync(51)
      expect(sent).toHaveLength(1)
      expect(service.acknowledgeUpdate(contents.id, {
        subscriptionId: first.subscriptionId,
        generation: first.generation,
        deliveryId: first.deliveryId,
        result: "applied",
      })).toEqual({ accepted: true })

      const recovery = sent[1]!.payload as DesktopSessionUpdate
      expect(recovery.kind).toBe("snapshot")
      if (recovery.kind !== "snapshot") throw new Error("expected structural recovery snapshot")
      expect(recovery.view.syncStatus).toBe("connected")
      expect(recovery.view.cursor).toBe(3)
      expect(recovery.view.session.title).toBe("latest title")
      expect(recovery.view.parts[0]?.text).toBe("x")
    } finally {
      service.clearAll()
      await vi.advanceTimersByTimeAsync(0)
    }
  })

  it("observes a lifecycle generation before the renderer's coalesced update", async () => {
    vi.useFakeTimers()
    const client = clientWithStream(async function* () {
      yield { ...sessionUpdated(2), payload: { session: { ...session, metadata: { ...session.metadata, hostGeneration: "new-generation" } } } }
      await new Promise<never>(() => undefined)
    })
    const { contents, sent } = webContents()
    const service = new SessionSubscriptionService({ sessionUpdateIntervalMs: 50 })
    const observed: unknown[] = []
    service.onOwnerSnapshot((_id, view) => observed.push(view.session.metadata.hostGeneration))
    try {
      await service.openSession(client as never, contents as never, "s1")
      await vi.advanceTimersByTimeAsync(1)
      expect(observed).toContain("new-generation")
      expect(sent).toHaveLength(0)
      await vi.advanceTimersByTimeAsync(51)
      expect(sent).toHaveLength(1)
    } finally { service.clearAll() }
  })
  it("keeps retry supersession and usage completeness when intermediate frames are skipped", async () => {
    vi.useFakeTimers()
    const run = { id: "r", sessionId: "s1", status: "running", metadata: {}, createdAt: 1, updatedAt: 1 }
    const part = { id: "p1", sessionId: "s1", messageId: "m", seq: 1, type: "text", status: "running", text: "obsolete", metadata: {}, createdAt: 1, updatedAt: 1 }
    const event = (seq: number, type: string, payload: Record<string, unknown>): SessionEventRecord => ({
      id: `e${seq}`, seq, type, schemaVersion: 1, sessionId: "s1", payload, createdAt: seq,
    })
    const client = clientWithStream(async function* () {
      yield event(2, "session.message.created", { message: { id: "m", sessionId: "s1", seq: 1, role: "assistant", metadata: {}, createdAt: 1, updatedAt: 1 } })
      yield event(3, "session.message.part.updated", { part })
      yield event(4, "session.run.updated", { run: { ...run, metadata: { modelRetry: { generationId: "g", attempt: 1, retryNumber: 1, maxRetries: 5, reason: "network", nextRetryAt: 10, recoveryDeadlineAt: 1000 } } } })
      yield event(5, "session.message.part.updated", { part: { ...part, status: "interrupted", metadata: { modelGeneration: { generationId: "g", attempt: 1, superseded: true } } } })
      yield event(6, "session.message.part.updated", { part: { ...part, id: "p2", seq: 2, text: "answer", status: "completed", metadata: { modelGeneration: { generationId: "g", attempt: 2, committed: true } } } })
      yield event(7, "session.run.updated", { run: { ...run, status: "completed", metadata: { modelRetry: null, modelUsage: { incomplete: true, unknownAttempts: 1, partialAttempts: 0 } } } })
      await new Promise<never>(() => undefined)
    })
    const { contents, sent } = webContents()
    const service = new SessionSubscriptionService({ sessionUpdateIntervalMs: 50 })
    try {
      await service.openSession(client as never, contents as never, "s1")
      await vi.advanceTimersByTimeAsync(51)
      expect(sent).toHaveLength(1)
      const update = sent[0]!.payload as DesktopSessionUpdate
      if (update.kind !== "snapshot") throw new Error("expected snapshot delivery")
      const view = update.view
      expect(visibleTranscriptParts(view.parts, true).map(p => p.text)).toEqual(["answer"])
      expect(view.runs[0]?.metadata).toMatchObject({ modelRetry: null, modelUsage: { incomplete: true } })
    } finally { service.clearAll() }
  })
  it("collapses a live burst into one sessionUpdated with the latest cursor", async () => {
    vi.useFakeTimers()
    const client = clientWithStream(async function* () {
      yield sessionUpdated(2)
      yield sessionUpdated(3)
      yield sessionUpdated(4)
      await new Promise<never>(() => undefined)
    })
    const { contents, sent } = webContents()
    const service = new SessionSubscriptionService({ sessionUpdateIntervalMs: 50 })

    await service.openSession(client as never, contents as never, "s1")
    await vi.advanceTimersByTimeAsync(1)
    expect(sent).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(50)
    expect(sent).toHaveLength(1)
    expect(sent[0]!.channel).toBe("session:updated")
    expect((sent[0]!.payload as DesktopSessionUpdate)).toMatchObject({
      kind: "snapshot",
      view: { cursor: 4 },
    })

    service.clearAll()
  })

  it("flushes a reconnecting frame immediately, ahead of the next window", async () => {
    vi.useFakeTimers()
    const client = clientWithStream(async function* () {
      yield sessionUpdated(2)
      yield sessionUpdated(3)
      throw new Error("stream down")
    })
    const { contents, sent } = webContents()
    const service = new SessionSubscriptionService({ sessionUpdateIntervalMs: 50 })

    await service.openSession(client as never, contents as never, "s1")
    await vi.advanceTimersByTimeAsync(1)

    expect(sent).toHaveLength(1)
    expect((sent[0]!.payload as DesktopSessionUpdate)).toMatchObject({
      kind: "snapshot",
      view: { syncStatus: "reconnecting" },
    })

    service.clearAll()
  })

  it("does not send a pending window after the session subscription closes", async () => {
    vi.useFakeTimers()
    const client = clientWithStream(async function* () {
      yield sessionUpdated(2)
      yield sessionUpdated(3)
      await new Promise<never>(() => undefined)
    })
    const { contents, sent } = webContents()
    const service = new SessionSubscriptionService({ sessionUpdateIntervalMs: 50 })

    await service.openSession(client as never, contents as never, "s1")
    await vi.advanceTimersByTimeAsync(1)
    expect(sent).toHaveLength(0)

    service.closeSession(contents.id)
    await vi.advanceTimersByTimeAsync(1)
    await vi.advanceTimersByTimeAsync(50)

    expect(sent).toHaveLength(0)
    service.clearAll()
  })

  it("coalesces auxiliary subscriptions and tags the payload", async () => {
    vi.useFakeTimers()
    const client = clientWithStream(async function* () {
      yield sessionUpdated(2)
      yield sessionUpdated(3)
      yield sessionUpdated(4)
      await new Promise<never>(() => undefined)
    })
    const { contents, sent } = webContents()
    const service = new SessionSubscriptionService({ sessionUpdateIntervalMs: 50 })

    await service.openAuxSession(client as never, contents as never, {
      subscriptionId: "aux1",
      sessionId: "s1",
    })
    await vi.advanceTimersByTimeAsync(1)
    expect(sent).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(50)
    expect(sent).toHaveLength(1)
    expect(sent[0]!.channel).toBe("session:aux-updated")
    expect(sent[0]!.payload).toMatchObject({ subscriptionId: "aux1" })

    service.clearAll()
  })

  it("drops a pending window when the window is destroyed", async () => {
    vi.useFakeTimers()
    const client = clientWithStream(async function* () {
      yield sessionUpdated(2)
      yield sessionUpdated(3)
      await new Promise<never>(() => undefined)
    })
    const { contents, sent, destroy } = webContents()
    const service = new SessionSubscriptionService({ sessionUpdateIntervalMs: 50 })

    await service.openSession(client as never, contents as never, "s1")
    await vi.advanceTimersByTimeAsync(1)
    expect(sent).toHaveLength(0)

    destroy()
    await vi.advanceTimersByTimeAsync(50)

    expect(sent).toHaveLength(0)
    service.clearAll()
  })

  it("cancels a pending window when the same auxiliary slot is reopened", async () => {
    vi.useFakeTimers()
    const first = clientWithStream(async function* () {
      yield sessionUpdated(2)
      yield sessionUpdated(3)
      await new Promise<never>(() => undefined)
    })
    const second = clientWithStream(async function* () {
      await new Promise<never>(() => undefined)
    })
    const { contents, sent } = webContents()
    const service = new SessionSubscriptionService({ sessionUpdateIntervalMs: 50 })

    await service.openAuxSession(first as never, contents as never, {
      subscriptionId: "aux1",
      sessionId: "s1",
    })
    await vi.advanceTimersByTimeAsync(1)
    expect(sent).toHaveLength(0)

    await service.openAuxSession(second as never, contents as never, {
      subscriptionId: "aux1",
      sessionId: "s1",
    })
    await vi.advanceTimersByTimeAsync(1)
    await vi.advanceTimersByTimeAsync(50)

    expect(sent).toHaveLength(0)
    service.clearAll()
  })

  it("drops the subscription when the session disappears mid-stream", async () => {
    vi.useFakeTimers()
    const client = clientWithStream(async function* () {
      yield sessionUpdated(2)
      yield sessionDeleted(3)
      await new Promise<never>(() => undefined)
    })
    const { contents, sent } = webContents()
    const service = new SessionSubscriptionService({ sessionUpdateIntervalMs: 50 })

    await service.openSession(client as never, contents as never, "s1")
    await vi.advanceTimersByTimeAsync(1)

    expect(service.hasPrimary(contents.id, "s1")).toBe(false)
    await vi.advanceTimersByTimeAsync(50)
    expect(sent).toHaveLength(0)
    service.clearAll()
  })
})

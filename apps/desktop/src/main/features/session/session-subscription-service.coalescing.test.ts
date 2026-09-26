import { afterEach, describe, expect, it, vi } from "vitest"
import type { SessionEventRecord, SessionStateSnapshot } from "@vykor/client"

import { SessionSubscriptionService } from "./session-subscription-service"
import { visibleTranscriptParts } from "../../../renderer/src/components/desktop/conversation-page/transcript/transcript-visibility"
import type { DesktopSessionView } from "../../../shared/session-types"

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
      const view = sent[0]!.payload as DesktopSessionView
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
    expect((sent[0]!.payload as { cursor: number }).cursor).toBe(4)

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
    expect((sent[0]!.payload as { syncStatus: string }).syncStatus).toBe("reconnecting")

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

import { afterEach, describe, expect, it, vi } from "vitest"
import { EventEmitter, on } from "node:events"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import type { ComponentType } from "react"
import type { SessionEventRecord, SessionStateSnapshot } from "@vykor/client"

import { SessionSubscriptionService } from "./session-subscription-service"
import { visibleTranscriptParts } from "../../../renderer/src/components/desktop/conversation-page/transcript/transcript-visibility"
import { isToolGenerationPresentation, withToolGenerationPresentation } from "../../../renderer/src/components/desktop/conversation-page/message/tool-generation-presentation"
import type {
  DesktopSessionUpdate,
  DesktopSessionUpdateAck,
  DesktopSessionResyncRequest,
  DesktopSessionView,
} from "../../../shared/session-types"
import { OpenAICompatibleClient } from "../../../../../../packages/api/src/providers/openai"
import { QueryEngine } from "../../../../../../packages/core/src/engine/query-engine"
import { ToolRegistry } from "../../../../../../packages/core/src/engine/tool-registry"
import { AgentSession } from "../../../../../../packages/core/src/agent-session"
import { FrameworkAgentRun } from "../../../../../../packages/agent-runtime/src/framework-agent-run"
import { AgentEventBus } from "../../../../../../packages/agent-runtime/src/event-source"
import { fileWriteTool } from "../../../../../../packages/tools/src/file/write"
import { SessionStore } from "../../../../../../packages/services/src/session-runtime/store"
import { DaemonAgentEventProjector } from "../../../../../../packages/server/src/application/agent/daemon-agent-event-projector"
import { SessionTranscriptProjection } from "../../../../../../packages/server/src/application/session/transcript-projection"
import { SessionEventPublisher } from "../../../../../../packages/server/src/application/session/session-event-publisher"

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
      yield { ...sessionUpdated(2), payload: { session: { ...session, metadata: { ...session.metadata, pluginUiGeneration: "new-generation" } } } }
      await new Promise<never>(() => undefined)
    })
    const { contents, sent } = webContents()
    const service = new SessionSubscriptionService({ sessionUpdateIntervalMs: 50 })
    const observed: unknown[] = []
    service.onOwnerSnapshot((_id, view) => observed.push(view.session.metadata.pluginUiGeneration))
    try {
      await service.openSession(client as never, contents as never, "s1")
      await vi.advanceTimersByTimeAsync(1)
      expect(observed).toContain("new-generation")
      expect(sent).toHaveLength(0)
      await vi.advanceTimersByTimeAsync(51)
      expect(sent).toHaveLength(1)
    } finally { service.clearAll() }
  })
  it("shows a real Write generation in the transcript while arguments are paused, then hands off once", async () => {
    vi.useFakeTimers()
    const directory = mkdtempSync(join(tmpdir(), "vykor-write-timing-"))
    let createdStore: SessionStore | undefined
    let service: SessionSubscriptionService | undefined
    let run: FrameworkAgentRun | undefined
    let releaseArguments: (() => void) | undefined
    try {
      const target = join(directory, "new.html")
      const body = "<p>generated content</p>\n".repeat(160)
      const raw = JSON.stringify({ file_path: target, content: body })
      const split = Math.floor(raw.length / 2)
      const argumentsGate = new Promise<void>(resolve => { releaseArguments = resolve })
      let notifyPaused!: () => void
      const providerPaused = new Promise<void>(resolve => { notifyPaused = resolve })
      let notifySubscribed!: () => void
      const subscribed = new Promise<void>(resolve => { notifySubscribed = resolve })
      let notifyGenerationView!: (view: DesktopSessionView) => void
      const generationView = new Promise<DesktopSessionView>(resolve => { notifyGenerationView = resolve })
      const store = new SessionStore({ path: join(directory, "session.db") })
      createdStore = store
      const session = store.sessions.create({ cwd: directory, model: "test", metadata: {
        runtime: { model: "test" }, desktop: { workspaceMode: "outside_project" },
      } })
      const live = new EventEmitter()
      const publisher = new SessionEventPublisher(store.conversations, {
        broadcastEvent: event => { live.emit("event", event) },
        broadcastSince: seq => {
          for (const event of store.conversations.listEvents({ afterSeq: seq })) live.emit("event", event)
        },
      })
      const projector = new DaemonAgentEventProjector({
        rootAgent: {} as never, store, transcriptProjection: new SessionTranscriptProjection(store),
        executionProjector: {} as never, liveChildren: { register() {}, unregister() {} },
        events: publisher, log() {},
      })
      const transport = {
        sessions: { getState: async () => store.conversationTransactions.getSessionState(session.id) },
        events: {
          list: async (options?: { cursor?: number }) => store.conversations.listEvents({ afterSeq: options?.cursor, sessionId: session.id }),
          stream: async function* (options: { signal?: AbortSignal }) {
            const events = on(live, "event", { signal: options.signal })
            notifySubscribed()
            for await (const [event] of events) yield event
          },
        },
      }
      const sent: DesktopSessionView[] = []
      const contents = { id: 78, once: vi.fn(), isDestroyed: () => false,
        send: vi.fn((channel: string, payload: DesktopSessionUpdate) => {
          if (channel !== "session:updated") return
          if (payload.kind === "snapshot") {
            const view = payload.view
            sent.push(view)
            if (view.runs.some(run => Array.isArray(run.metadata.toolGeneration) &&
              run.metadata.toolGeneration.some(entry => entry.toolName === "Write"))) notifyGenerationView(view)
          }
          service?.acknowledgeUpdate(78, {
            subscriptionId: payload.subscriptionId,
            generation: payload.generation,
            deliveryId: payload.deliveryId,
            result: "applied",
          })
        }),
      }
      service = new SessionSubscriptionService({ sessionUpdateIntervalMs: 50 })
        await service.openSession(transport as never, contents as never, session.id)
        await vi.advanceTimersByTimeAsync(1)
        await subscribed

        const client = new OpenAICompatibleClient({ apiKey: "test" })
        let requests = 0
        client.client = { chat: { completions: { create: async (_request: unknown, options: { signal?: AbortSignal }) => ({
          async *[Symbol.asyncIterator]() {
            if (requests++ === 0) {
              yield { choices: [{ delta: { tool_calls: [{ index: 0, id: "write-call", type: "function",
                function: { name: "Write", arguments: raw.slice(0, split) } }] } }] }
              notifyPaused()
              await argumentsGate
              options.signal?.throwIfAborted()
              yield { choices: [{ delta: { tool_calls: [{ index: 0,
                function: { arguments: raw.slice(split) } }] } }] }
              yield { choices: [{ delta: {}, finish_reason: "tool_calls" }] }
            } else {
              yield { choices: [{ delta: { content: "Finished" } }] }
              yield { choices: [{ delta: {}, finish_reason: "stop" }] }
            }
          },
        }) } } } as never
        let executions = 0
        const registry = new ToolRegistry()
        registry.register({ ...fileWriteTool, execute: async (input, context) => {
          executions++
          return fileWriteTool.execute(input, context)
        } }, { kind: "builtin" })
        const engine = new QueryEngine(client, registry,
          { checkTool: async () => ({ action: "allow" as const }) },
          { register() {}, execute: async () => ({ blocked: false }) },
          { cwd: directory, model: "test", trajectoryTrackerFactory: false })
        const actualEvents: string[] = []
        run = new FrameworkAgentRun({
          agentId: "agent", ids: { inputId: "input", runId: "run", traceId: "trace" },
          content: "Create the file", delivery: "queue", session: new AgentSession({ queryEngine: engine, sessionId: session.id }),
          runtime: { queryEngine: engine } as never,
          eventBus: new AgentEventBus(async event => { actualEvents.push(event.type); await projector.apply(event) }),
          effects: {} as never, children: { cwd: directory, createController: () => ({}) } as never,
          onSettled() {},
        })
        await providerPaused
        await vi.advanceTimersByTimeAsync(51)
        const pausedView = await generationView
        const presented = withToolGenerationPresentation(pausedView.runs, pausedView.messages, pausedView.parts)
        const generated = presented.parts.filter(isToolGenerationPresentation)
        expect(pausedView.runs[0]?.metadata.toolGeneration).toEqual([expect.objectContaining({ toolName: "Write" })])
        expect(generated).toHaveLength(1)
        expect(generated[0]).toMatchObject({ toolName: "Write", metadata: {
          toolProgress: { phase: "generating", executionState: "not_started" },
        } })
        expect(generated[0]?.toolUseId).toBeUndefined()
        expect(pausedView.parts.filter(part => part.type === "tool")).toHaveLength(0)
        expect(executions).toBe(0)
        expect(existsSync(target)).toBe(false)
        const { ConversationTranscript } = await vi.importActual<{ ConversationTranscript: ComponentType<any> }>(
          "../../../renderer/src/components/desktop/conversation-page/transcript/transcript")
        const { MessageScroller, MessageScrollerProvider } = await vi.importActual<{
          MessageScroller: ComponentType<any>; MessageScrollerProvider: ComponentType<any>
        }>("../../../renderer/src/components/ui/message-scroller")
        const html = renderToStaticMarkup(createElement(MessageScrollerProvider, null,
          createElement(MessageScroller, null, createElement(ConversationTranscript, {
            messages: pausedView.messages, parts: pausedView.parts, runs: pausedView.runs,
            running: true, canEditLastUserMessage: false, canOpenReview: false,
            onEditLastUserMessage() {}, onCopyAssistantMessage() {}, onOpenFile() {}, onOpenReview() {}, onOpenTerminal() {},
          }))))
        const groupHtml = html.match(/<section aria-label="工具活动组"[^>]*>([\s\S]*?)<\/section>/)?.[1]
        expect(groupHtml).toBeDefined()
        expect(groupHtml).toContain("写入文件")
        expect(groupHtml).toContain("new.html")
        expect(groupHtml).toContain('aria-label="正在生成文件内容，尚未开始执行"')
        expect(html).not.toContain("文件编辑 1 次")

        releaseArguments?.()
        await run.result
        await vi.advanceTimersByTimeAsync(51)
        const completedView = sent.at(-1)!
        expect(withToolGenerationPresentation(completedView.runs, completedView.messages, completedView.parts)
          .parts.filter(isToolGenerationPresentation)).toHaveLength(0)
        const formal = completedView.parts.filter(part => part.type === "tool")
        expect(formal).toHaveLength(1)
        expect(formal[0]).toMatchObject({ toolName: "Write", toolUseId: "write-call", status: "completed",
          output: { executionState: "completed" }, isError: false })
        expect(executions).toBe(1)
        expect(actualEvents.filter(type => type === "tool.started")).toHaveLength(1)
        expect(actualEvents.filter(type => type === "tool.completed")).toHaveLength(1)
        expect(engine.getHistory().filter(message => message.type === "tool_result")).toHaveLength(1)
        expect(readFileSync(target, "utf8")).toBe(body)
    } finally {
      service?.clearAll()
      releaseArguments?.()
      if (run) await run.interrupt()
      try { createdStore?.close() }
      finally { rmSync(directory, { recursive: true, force: true }) }
    }
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

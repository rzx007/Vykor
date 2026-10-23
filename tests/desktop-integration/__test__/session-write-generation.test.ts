import { afterEach, describe, expect, it, vi } from "vitest"
import { EventEmitter, on } from "node:events"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import type { ComponentType } from "react"
import { QueryEngine, ToolRegistry, AgentSession } from "@vykor/core"
import { SessionSubscriptionService } from "../../../apps/desktop/src/main/features/session/session-subscription-service"
import { isToolGenerationPresentation, withToolGenerationPresentation } from "../../../apps/desktop/src/renderer/src/components/desktop/conversation-page/message/activity/tool-generation-presentation"
import type { DesktopSessionUpdate, DesktopSessionView } from "../../../apps/desktop/src/shared/session-types"
import { OpenAICompatibleClient } from "../../../packages/api/src/providers/openai"
import { FrameworkAgentRun } from "../../../packages/agent-runtime/src/kernel/framework-agent-run"
import { AgentEventBus } from "../../../packages/agent-runtime/src/kernel/event-source"
import { fileWriteTool } from "../../../packages/tools/src/file/write"
import { SessionStore } from "../../../packages/services/src/session-runtime/store"
import { DaemonAgentEventProjector } from "../../../packages/server/src/application/agent/daemon-agent-event-projector"
import { SessionTranscriptProjection } from "../../../packages/server/src/application/session/transcript-projection"
import { SessionEventPublisher } from "../../../packages/server/src/application/session/session-event-publisher"

// 在模拟计时与断言开始前加载聊天组件，避免首次加载占用用例的超时限额。
const { ConversationTranscript } = await vi.importActual<{ ConversationTranscript: ComponentType<any> }>(
  "../../../apps/desktop/src/renderer/src/components/desktop/conversation-page/transcript/transcript")
const { MessageScroller, MessageScrollerProvider } = await vi.importActual<{
  MessageScroller: ComponentType<any>; MessageScrollerProvider: ComponentType<any>
}>("../../../apps/desktop/src/renderer/src/components/ui/message-scroller")

afterEach(() => { vi.useRealTimers() })

describe("Write generation through runtime, projection and desktop", () => {
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
          { execute: async () => ({ blocked: false }) },
          { cwd: directory, model: "test", trajectoryTrackerFactory: false })
        const actualEvents: string[] = []
        run = new FrameworkAgentRun({
          agentId: "agent", ids: { inputId: "input", runId: "run", traceId: "trace" },
          content: "Create the file", delivery: "queue", session: new AgentSession({ queryEngine: engine, sessionId: session.id }),
          engine, preparation: { prepare: async () => ({ run: { tools: new Map(registry.getAll().map(tool => [tool.name, { definition: tool, invoke: tool.execute.bind(tool) }])) }, release() {} }) },
          eventBus: new AgentEventBus(async event => { actualEvents.push(event.type); await projector.apply(event) }),
          effects: {} as never, children: { cwd: directory, createController: () => ({}) } as never,
          onSettled() {},
        })
        await Promise.race([providerPaused, run.result.then(result => { throw new Error(`Model did not reach the arguments gate: ${JSON.stringify(result)}`) })])
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
})

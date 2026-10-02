import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { DesktopSessionRun } from "@shared/session-types"
import { MessageScroller, MessageScrollerProvider } from "@renderer/components/ui/message-scroller"
import { ConversationTranscript } from "../transcript"
import { AgentActivityMessage } from "../../message/agent-activity-message"

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(100_000)
})
afterEach(() => vi.useRealTimers())
const run: DesktopSessionRun = {
  id: "run",
  sessionId: "chat",
  inputId: "input",
  status: "completed",
  startedAt: 1_000,
  finishedAt: 66_000,
  metadata: {},
  createdAt: 500,
  updatedAt: 66_000,
}

function render(runs: DesktopSessionRun[], running = false): string {
  const messages = [
    { id: "user", role: "user" as const, seq: 1 },
    { id: "assistant", role: "assistant" as const, seq: 2, runId: runs.at(-1)?.id },
  ].map((message) => ({
    ...message,
    sessionId: "chat",
    inputId: "input",
    metadata: {},
    createdAt: 1,
    updatedAt: 1,
  }))
  const parts = messages.map((message) => ({
    id: `part-${message.id}`,
    messageId: message.id,
    sessionId: "chat",
    seq: 1,
    type: "text" as const,
    text: message.id === "user" ? "处理任务" : "已经处理",
    status: "completed" as const,
    metadata: {},
    createdAt: 1,
    updatedAt: 1,
  }))
  return renderToStaticMarkup(
    createElement(
      MessageScrollerProvider,
      null,
      createElement(
        MessageScroller,
        null,
        createElement(ConversationTranscript, {
          messages,
          parts,
          runs,
          running,
          canEditLastUserMessage: false,
          onEditLastUserMessage: () => undefined,
          onCopyAssistantMessage: () => undefined,
          onOpenFile: () => undefined,
          canOpenReview: false,
          onOpenReview: () => undefined,
          onOpenTerminal: () => undefined,
        })
      )
    )
  )
}

it("keeps completed duration above message actions after reopening a historical task", () => {
  vi.setSystemTime(9_999_999)
  const html = render([run])
  expect(html).toContain("耗时")
  expect(html).toContain("1分5秒")
  expect(html.indexOf("耗时")).toBeLessThan(html.indexOf('aria-label="复制回复"'))
  expect(html.match(/data-task-duration/g)).toHaveLength(1)
})

it("restores live elapsed time from the stored start instead of the mount time", () => {
  vi.setSystemTime(31_000)
  const live = { ...run, status: "running" as const, finishedAt: undefined }
  expect(render([live], true)).toContain("30秒")
  vi.setSystemTime(61_000)
  expect(render([live], true)).toContain("1分0秒")
})

it("shows one wall-clock duration across multiple runs of the same input", () => {
  expect(
    render([
      { ...run, finishedAt: 5_000 },
      { ...run, id: "second", createdAt: 7_000, startedAt: 8_000, finishedAt: 20_000 },
    ])
  ).toContain("19秒")
})

it("preserves elapsed time for interrupted work and hides unknown historic timing", () => {
  expect(render([{ ...run, status: "interrupted", finishedAt: 25_000 }])).toContain("24秒")
  expect(render([{ ...run, status: "interrupted", finishedAt: 25_000 }])).toContain("已中断")
  expect(render([{ ...run, startedAt: undefined, finishedAt: undefined }])).not.toContain(
    "data-task-duration"
  )
})

it("puts the agent's own elapsed time alongside its task status", () => {
  const html = renderToStaticMarkup(
    createElement(AgentActivityMessage, {
      call: {
        id: "agent",
        sessionId: "chat",
        messageId: "assistant",
        seq: 1,
        type: "tool",
        toolName: "Agent",
        status: "completed",
        metadata: {},
        createdAt: 1,
        updatedAt: 1,
        output: JSON.stringify({ kind: "job", jobKind: "agent", action: "created", jobId: "task" }),
      },
      tasks: [
        {
          id: "task",
          sessionId: "chat",
          childSessionId: "child",
          type: "agent",
          status: "completed",
          description: "检查代码",
          cwd: "/repo",
          metadata: {},
          createdAt: 1,
          updatedAt: 18_000,
          startedAt: 0,
          finishedAt: 18_000,
        },
      ],
    })
  )
  expect(html).toContain("已完成")
  expect(html).toContain("18秒")
})

import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { DesktopSessionPart, DesktopSessionRun } from "@shared/session-types"
import { MessageScroller, MessageScrollerProvider } from "@renderer/components/ui/message-scroller"
import { ConversationTranscript } from "../transcript"
import { AgentActivityMessage } from "../../message/activity/agent-activity-message"

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

function render(
  runs: DesktopSessionRun[],
  running = false,
  assistantParts?: DesktopSessionPart[]
): string {
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
          parts: assistantParts
            ? [...parts.filter((part) => part.messageId === "user"), ...assistantParts]
            : parts,
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
  expect(html).toContain("用时")
  expect(html).toContain("1分5秒")
  expect(html.indexOf("用时")).toBeLessThan(html.indexOf("已经处理"))
  expect(html.indexOf("用时")).toBeLessThan(html.indexOf('aria-label="复制回复"'))
  expect(html.match(/data-task-duration/g)).toHaveLength(1)
})

it("folds a completed process but keeps the answer, file summary and actions visible", () => {
  const base = {
    sessionId: "chat",
    messageId: "assistant",
    status: "completed" as const,
    createdAt: 1,
    updatedAt: 1,
  }
  const parts: DesktopSessionPart[] = [
    {
      ...base,
      id: "progress",
      seq: 1,
      type: "text",
      text: "正在检查文件",
      metadata: { phase: "commentary" },
    },
    {
      ...base,
      id: "write",
      seq: 2,
      type: "tool",
      toolUseId: "write-call",
      toolName: "Write",
      input: { file_path: "D:/report.md", content: "done" },
      metadata: {},
    },
    {
      ...base,
      id: "answer",
      seq: 3,
      type: "text",
      text: "报告已经完成",
      metadata: { phase: "final_answer" },
    },
  ]
  const html = render([run], false, parts)
  expect(html).toContain("用时 1分5秒")
  expect(html).toContain('aria-expanded="false"')
  expect(html).not.toContain("正在检查文件")
  expect(html).toContain("报告已经完成")
  expect(html).toContain('aria-label="文件编辑摘要"')
  expect(html).toContain('aria-label="复制回复"')
  expect(html).not.toContain("data-task-duration")

  const failed = render([{ ...run, status: "failed", error: "后台连接失败" }], false, parts)
  expect(failed).not.toContain("正在检查文件")
  expect(failed).toContain("报告已经完成")
  expect(failed).toContain("用时 1分5秒")
  expect(failed).toContain("后台连接失败")

  const stopped = render(
    [
      {
        ...run,
        status: "interrupted",
        metadata: {
          interruption: { source: "user", runId: run.id },
        },
      },
    ],
    false,
    parts
  )
  expect(stopped).toContain("你在 1分5秒后停止了")
  expect(stopped).toContain('aria-expanded="false"')
  expect(stopped).not.toContain("正在检查文件")
})

it("restores live elapsed time from the stored start instead of the mount time", () => {
  vi.setSystemTime(31_000)
  const live = { ...run, status: "running" as const, finishedAt: undefined }
  expect(render([live], true)).toContain("30秒")
  vi.setSystemTime(61_000)
  expect(render([live], true)).toContain("1分0秒")
})

it("keeps the pre-token status only in TaskDuration for an empty assistant message", () => {
  const html = render([{ ...run, status: "running", finishedAt: undefined }], true, [])
  expect(html.match(/data-task-duration/g)).toHaveLength(1)
  expect(html).toContain('aria-label="等待模型响应"')
  expect(html).not.toContain("正在生成回复...")
})

it("shows the streaming reply status only in TaskDuration", () => {
  const html = render([{ ...run, status: "running", finishedAt: undefined }], true, [
    {
      id: "reply",
      messageId: "assistant",
      sessionId: "chat",
      seq: 1,
      type: "text",
      text: "新的回复",
      status: "running",
      metadata: {},
      createdAt: 1,
      updatedAt: 2,
    },
  ])
  expect(html.match(/data-task-duration/g)).toHaveLength(1)
  expect(html).toContain('aria-label="正在生成回复"')
  expect(html).toContain("新的回复")
  expect(html).not.toContain("正在生成回复...")
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
  expect(render([{ ...run, status: "interrupted", finishedAt: 25_000 }])).toContain(
    "执行在 24秒后中断"
  )
  expect(render([{ ...run, startedAt: undefined, finishedAt: undefined }])).not.toContain(
    "data-task-duration"
  )
  expect(
    render([{ ...run, status: "interrupted", startedAt: undefined, finishedAt: undefined }])
  ).toContain("执行已中断")
})

it.each(["user", "system"] as const)(
  "puts an interrupted status before the process without adding a fold (%s)",
  (source) => {
    const html = render([
      {
        ...run,
        status: "interrupted",
        metadata: {
          interruption: { source, runId: run.id },
        },
      },
    ])
    const label = source === "user" ? "你在 1分5秒后停止了" : "执行在 1分5秒后中断"
    expect(html.indexOf(label)).toBeGreaterThan(html.indexOf("处理任务"))
    expect(html.indexOf(label)).toBeLessThan(html.indexOf("已经处理"))
    expect(html.match(/data-task-duration/g)).toHaveLength(1)
    expect(html).not.toContain("collapsible-trigger")
  }
)

it("restores an explicit user stop from saved metadata and uses the latest recovery status", () => {
  const stopped: DesktopSessionRun = {
    ...run,
    status: "interrupted",
    finishedAt: 25_000,
    metadata: { interruption: { source: "user", runId: run.id, requestedAt: 25_000 } },
  }
  expect(render([JSON.parse(JSON.stringify(stopped))])).toContain("你在 24秒后停止了")
  const resumed = {
    ...run,
    id: "recovery",
    createdAt: 30_000,
    startedAt: 31_000,
    finishedAt: 40_000,
  }
  expect(render([stopped, resumed])).toContain("用时 39秒")
  expect(render([stopped, resumed])).not.toContain("你在")
  expect(render([{ ...resumed, status: "interrupted", metadata: stopped.metadata }])).not.toContain(
    "你在"
  )
})

it("does not infer a user stop from an error string, stalled run or system source", () => {
  for (const metadata of [
    {},
    { stalled: true },
    { interruption: { source: "system", runId: run.id } },
  ]) {
    const html = render([{ ...run, status: "interrupted", error: "Run interrupted", metadata }])
    expect(html).toContain("执行在 1分5秒后中断")
    expect(html).not.toContain("你在")
  }
})

it.each([
  { interruption: { source: "user", runId: run.id, wasPending: true } },
  { cancellation: { kind: "user_cancelled_pending" } },
])(
  "shows a user cancellation without inventing elapsed time before execution starts",
  (metadata) => {
    const html = render([{ ...run, status: "interrupted", startedAt: undefined, metadata }])
    expect(html).toContain("你取消了等待中的任务")
    expect(html).not.toContain("秒后")
  }
)

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

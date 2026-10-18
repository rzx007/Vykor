import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { expect, it } from "vitest"
import { ConversationTranscript } from "../transcript"
import { MessageScroller, MessageScrollerProvider } from "@renderer/components/ui/message-scroller"
import type { DesktopSessionPart, DesktopSessionView } from "@shared/session-types"

const view: DesktopSessionView = {
  cursor: 1,
  syncStatus: "connected",
  session: {
    id: "session-a",
    cwd: "/repo",
    title: "Review",
    model: "model",
    status: "running",
    metadata: {},
    createdAt: 1,
    updatedAt: 1,
  },
  runs: [
    {
      id: "run-a",
      sessionId: "session-a",
      inputId: "input-a",
      status: "pending",
      metadata: { pluginId: "dev.quality" },
      createdAt: 1,
      updatedAt: 1,
    },
  ],
  inputs: [
    {
      id: "input-a",
      sessionId: "session-a",
      seq: 1,
      delivery: "queue",
      content: "@Quality review",
      items: [
        { type: "capability", kind: "plugin", pluginId: "dev.quality", displayName: "Quality" },
      ],
      attachments: [],
      metadata: {},
      createdAt: 1,
    },
  ],
  permissions: [],
  messages: [],
  parts: [],
  tasks: [],
}
const running: DesktopSessionView = {
  ...view,
  runs: [{ ...view.runs[0]!, status: "running" }],
  messages: [
    {
      id: "user-a",
      sessionId: "session-a",
      inputId: "input-a",
      runId: "run-a",
      role: "user",
      seq: 1,
      metadata: {},
      createdAt: 1,
      updatedAt: 1,
    },
  ],
  parts: [
    {
      id: "user-text",
      sessionId: "session-a",
      messageId: "user-a",
      seq: 1,
      type: "text",
      text: "@Quality review",
      status: "completed",
      metadata: {},
      createdAt: 1,
      updatedAt: 1,
    },
  ],
}
function render(state = view) {
  return renderToStaticMarkup(
    createElement(
      MessageScrollerProvider,
      null,
      createElement(
        MessageScroller,
        null,
        createElement(ConversationTranscript, {
          messages: state.messages,
          parts: state.parts,
          runs: state.runs,
          inputs: state.inputs,
          tasks: state.tasks,
          running: state.runs.some((run) => run.status === "pending" || run.status === "running"),
          canEditLastUserMessage: false,
          canOpenReview: false,
          onEditLastUserMessage: () => undefined,
          onCopyAssistantMessage: () => undefined,
          onOpenFile: () => undefined,
          onOpenReview: () => undefined,
          onOpenTerminal: () => undefined,
        })
      )
    )
  )
}
it.each(["pending", "running"] as const)(
  "shows preparation for %s even when the Run already has user text",
  (phase) => {
    const html = render(phase === "pending" ? view : running)
    const block = html.match(/data-task-duration[\s\S]*?<\/div>/)?.[0]
    expect(block).toContain("正在准备 Quality")
    expect(block).toContain('data-orb-state="connecting"')
    expect(html.match(/data-task-duration/g)).toHaveLength(1)
  }
)
it.each(["text", "reasoning", "tool", "tool_result"] as const)(
  "ends preparation once assistant %s is projected",
  (type) => {
    const output: DesktopSessionPart = {
      id: "output",
      sessionId: "session-a",
      messageId: "assistant-a",
      seq: 1,
      type,
      text: "output",
      status: "running",
      metadata: {},
      createdAt: 2,
      updatedAt: 2,
    }
    expect(
      render({
        ...running,
        messages: [
          ...running.messages,
          {
            id: "assistant-a",
            sessionId: "session-a",
            runId: "run-a",
            role: "assistant",
            seq: 2,
            metadata: {},
            createdAt: 2,
            updatedAt: 2,
          },
        ],
        parts: [...running.parts, output],
      })
    ).not.toContain("正在准备 Quality")
  }
)
it.each(["running", "completed"] as const)("ends preparation when a Child task is %s", (status) => {
  expect(
    render({
      ...running,
      tasks: [
        {
          id: "child-task",
          sessionId: "session-a",
          runId: "run-a",
          childSessionId: "child-a",
          type: "agent",
          status,
          description: "Review",
          cwd: "/repo",
          metadata: {},
          createdAt: 2,
          updatedAt: 2,
        },
      ],
    })
  ).not.toContain("正在准备 Quality")
})
it("ignores output from other runs and empty assistant envelopes", () => {
  expect(
    render({
      ...running,
      messages: [
        ...running.messages,
        {
          id: "assistant-empty",
          sessionId: "session-a",
          runId: "run-a",
          role: "assistant",
          seq: 2,
          metadata: {},
          createdAt: 2,
          updatedAt: 2,
        },
        {
          id: "assistant-old",
          sessionId: "session-a",
          runId: "run-old",
          role: "assistant",
          seq: 3,
          metadata: {},
          createdAt: 2,
          updatedAt: 2,
        },
      ],
      parts: [
        ...running.parts,
        {
          id: "old-output",
          sessionId: "session-a",
          messageId: "assistant-old",
          seq: 1,
          type: "text",
          text: "old",
          status: "completed",
          metadata: {},
          createdAt: 2,
          updatedAt: 2,
        },
      ],
    })
  ).toContain("正在准备 Quality")
})
it("hides preparation for a terminal Run", () => {
  expect(render({ ...running, runs: [{ ...running.runs[0]!, status: "failed" }] })).not.toContain(
    "正在准备 Quality"
  )
})
it("does not show a queued plugin's preparation while another run is active", () => {
  expect(
    render({
      ...running,
      runs: [
        view.runs[0]!,
        {
          id: "run-other",
          sessionId: "session-a",
          status: "running",
          metadata: {},
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    })
  ).not.toContain("正在准备 Quality")
})
it("uses a generic preparation label when the plugin reference is unavailable", () => {
  expect(render({ ...running, inputs: [] })).toContain("正在准备插件")
})

it("keeps model retry ahead of plugin preparation", () => {
  const html = render({
    ...running,
    runs: [
      {
        ...running.runs[0]!,
        metadata: {
          pluginId: "dev.quality",
          modelRetry: {
            generationId: "g",
            attempt: 1,
            retryNumber: 1,
            maxRetries: 3,
            reason: "stream_incomplete",
            nextRetryAt: 100,
            recoveryDeadlineAt: 200,
          },
        },
      },
    ],
  })
  expect(html.match(/data-task-duration[\s\S]*?<\/div>/)?.[0]).toContain("等待重试")
  expect(html).not.toContain("正在准备 Quality")
})

it("switches from plugin preparation to tool generation before a tool call is projected", () => {
  const html = render({
    ...running,
    runs: [
      {
        ...running.runs[0]!,
        metadata: {
          pluginId: "dev.quality",
          toolGeneration: [
            {
              generationId: "g",
              attempt: 1,
              toolKey: "0",
              toolUseId: "call",
              toolName: "Write",
              receivedChars: 100,
            },
          ],
        },
      },
    ],
  })
  expect(html.match(/data-task-duration[\s\S]*?<\/div>/)?.[0]).toContain("正在处理")
  expect(html).not.toContain("正在准备 Quality")
})

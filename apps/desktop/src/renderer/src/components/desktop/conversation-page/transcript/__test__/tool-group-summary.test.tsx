import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { expect, it } from "vitest"
import type {
  DesktopSessionMessage,
  DesktopSessionPart,
  DesktopSessionRun,
} from "@shared/session-types"
import { MessageScroller, MessageScrollerProvider } from "@renderer/components/ui/message-scroller"
import { ConversationTranscript } from "../transcript"

const base = {
  sessionId: "chat",
  inputId: "input",
  metadata: {},
  createdAt: 1,
  updatedAt: 1,
}

const messages: DesktopSessionMessage[] = [
  { ...base, id: "user", seq: 1, role: "user" },
  { ...base, id: "call", seq: 2, runId: "run", role: "assistant" },
  { ...base, id: "answer", seq: 3, runId: "run", role: "assistant" },
]

const userPart: DesktopSessionPart = {
  ...base,
  messageId: "user",
  id: "user-text",
  seq: 1,
  type: "text",
  text: "处理任务",
  status: "completed",
}

const callParts: DesktopSessionPart[] = [
  {
    ...base,
    messageId: "call",
    id: "shell-1",
    seq: 1,
    type: "tool",
    toolUseId: "shell-1-call",
    toolName: "Shell",
    input: { command: "pnpm test" },
    status: "completed",
  },
  {
    ...base,
    messageId: "call",
    id: "shell-2",
    seq: 2,
    type: "tool",
    toolUseId: "shell-2-call",
    toolName: "Shell",
    input: { command: "pnpm lint" },
    status: "completed",
  },
]

const run: DesktopSessionRun = {
  ...base,
  id: "run",
  status: "running",
  startedAt: 2,
}

function render(answerParts: DesktopSessionPart[]): string {
  return renderToStaticMarkup(
    createElement(
      MessageScrollerProvider,
      null,
      createElement(
        MessageScroller,
        null,
        createElement(ConversationTranscript, {
          messages,
          parts: [userPart, ...callParts, ...answerParts],
          runs: [run],
          running: true,
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

it("shows the completed summary once the next assistant message is settled text", () => {
  const html = render([
    {
      ...base,
      messageId: "answer",
      id: "answer-text",
      seq: 1,
      type: "text",
      text: "已经完成",
      status: "completed",
      metadata: { phase: "final_answer" },
    },
  ])
  expect(html).toContain("运行了命令")
  expect(html).not.toContain("运行命令 · pnpm test")
})

it("keeps the latest tool while the next assistant message still calls tools", () => {
  const html = render([
    {
      ...base,
      messageId: "answer",
      id: "answer-text",
      seq: 1,
      type: "text",
      text: "继续检查",
      status: "completed",
    },
    {
      ...base,
      messageId: "answer",
      id: "answer-read",
      seq: 2,
      type: "tool",
      toolUseId: "answer-read-call",
      toolName: "Read",
      input: { file_path: "result.txt" },
      status: "completed",
    },
  ])
  expect(html).toContain("运行命令 · pnpm lint")
  expect(html).not.toContain("运行了命令")
})

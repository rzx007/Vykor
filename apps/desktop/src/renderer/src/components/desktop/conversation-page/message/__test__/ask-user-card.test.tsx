import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

import { AskUserCard } from "../ask-user-card"
import { isAskUserPermission } from "../ask-user-payload"

const permission = {
  id: "question-1",
  sessionId: "session-1",
  toolName: "AskUser",
  payload: {
    input: {
      kind: "question",
      questions: [
        { question: "Choose a mode", options: ["Fast", "Careful"] },
        { question: "Anything else?" },
      ],
    },
  },
  status: "pending" as const,
  createdAt: 1,
  updatedAt: 1,
}

describe("AskUserCard", () => {
  it("recognizes question permissions and renders the first question", () => {
    expect(isAskUserPermission(permission)).toBe(true)
    const html = renderToStaticMarkup(
      createElement(AskUserCard, {
        permission,
        onReply: vi.fn(),
      })
    )
    expect(html).toContain("Choose a mode")
    expect(html).toContain("Fast")
    expect(html).toContain("继续")
  })

  it("does not classify ordinary permission requests as questions", () => {
    expect(
      isAskUserPermission({ ...permission, toolName: "Write", payload: { input: {} } })
    ).toBe(false)
  })

  it("renders a visible input control when the question has no options", () => {
    const html = renderToStaticMarkup(
      createElement(AskUserCard, {
        permission: {
          ...permission,
          payload: { input: { kind: "question", question: "请输入任意回答" } },
        },
        onReply: vi.fn(),
      })
    )

    expect(html).toContain("请输入任意回答")
    expect(html).toContain("border-input")
    expect(html).toContain("输入其他答案")
  })
})

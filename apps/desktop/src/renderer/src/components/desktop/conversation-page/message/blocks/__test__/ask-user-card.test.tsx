// @vitest-environment jsdom
import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
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
        { question: "Choose a mode", type: "check", options: ["Fast", "Careful"] },
        { question: "Anything else?" },
      ],
    },
  },
  status: "pending" as const,
  createdAt: 1,
  updatedAt: 1,
}

describe("AskUserCard", () => {
  it("submits an explicit confirmation choice without typing", async () => {
    const container = document.createElement("div")
    document.body.append(container)
    const root = createRoot(container)
    const onReply = vi.fn()
    ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
    try {
      await act(async () => root.render(createElement(AskUserCard, {
        permission: { ...permission, payload: { input: { kind: "question", questions: [
          { question: "确认添加全局 MCP 服务？", type: "radio", options: ["确认添加", "取消"] },
        ] } } }, onReply,
      })))
      const option = [...container.querySelectorAll("button")].find(button => button.textContent?.includes("确认添加"))!
      expect(option).toBeDefined()
      expect(onReply).not.toHaveBeenCalled()
      await act(async () => option.click())
      const submit = [...container.querySelectorAll("button")].find(button => button.textContent?.includes("提交"))!
      await act(async () => submit.click())
      expect(onReply).toHaveBeenCalledOnce()
      expect(JSON.parse(onReply.mock.calls[0]![0])).toEqual({ selected: { 0: [0] }, custom: { 0: "" } })
    } finally {
      act(() => root.unmount())
      container.remove()
      delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT
    }
  })
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
    expect(html).toContain('data-question-type="check"')
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

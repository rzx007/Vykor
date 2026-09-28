import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

import { PermissionCard } from "../message-block"

describe("PermissionCard", () => {
  it("disables both decisions and shows the scoped error while a reply is pending", () => {
    const html = renderToStaticMarkup(
      createElement(PermissionCard, {
        permission: {
          id: "permission-1",
          sessionId: "session-1",
          toolName: "shell",
          payload: {},
          status: "pending",
          createdAt: 1,
          updatedAt: 1,
        },
        replyPending: true,
        replyError: "授权回复失败",
        onReply: vi.fn(),
      })
    )

    expect(html).toContain("正在提交")
    expect(html).toContain("授权回复失败")
    expect(html).toMatch(/<button[^>]*disabled[^>]*>拒绝<\/button>/)
    expect(html).toMatch(/<button[^>]*disabled[^>]*>正在提交<\/button>/)
  })

  it("shows the BrowserDeveloper scope, category, and risk as escaped text", () => {
    const reason =
      "检查 https://example.org/account 的 DOM 结构；只读取主框架，可能暴露内部数据。<script>alert(1)</script>"
    const html = renderToStaticMarkup(
      createElement(PermissionCard, {
        permission: {
          id: "permission-developer",
          sessionId: "session-1",
          toolName: "BrowserDeveloper",
          payload: { reason, input: { action: "inspect_dom" } },
          status: "pending",
          createdAt: 1,
          updatedAt: 1,
        },
        onReply: vi.fn(),
      })
    )

    expect(html).toContain("https://example.org/account")
    expect(html).toContain("inspect_dom")
    expect(html).toContain("允许本次")
    expect(html).not.toContain("<script>")
    expect(html).toContain("&lt;script&gt;")
  })

  it("does not invent a scope for a malformed BrowserDeveloper payload", () => {
    const html = renderToStaticMarkup(
      createElement(PermissionCard, {
        permission: {
          id: "permission-developer-bad",
          sessionId: "session-1",
          toolName: "BrowserDeveloper",
          payload: { reason: "no action here", input: {} },
          status: "pending",
          createdAt: 1,
          updatedAt: 1,
        },
        onReply: vi.fn(),
      })
    )

    expect(html).toContain("BrowserDeveloper")
    expect(html).not.toContain("检查类别")
    expect(html).toContain("允许")
  })

  it("keeps ordinary permission cards on their existing layout", () => {
    const html = renderToStaticMarkup(
      createElement(PermissionCard, {
        permission: {
          id: "permission-shell",
          sessionId: "session-1",
          toolName: "shell",
          payload: { reason: "run a command", input: { command: "ls" } },
          status: "pending",
          createdAt: 1,
          updatedAt: 1,
        },
        onReply: vi.fn(),
      })
    )

    expect(html).toContain("shell")
    expect(html).not.toContain("检查类别")
  })
})

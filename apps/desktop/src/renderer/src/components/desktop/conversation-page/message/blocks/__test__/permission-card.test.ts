// @vitest-environment jsdom
import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import type { DesktopPermissionRequest } from "@shared/session-types"

import { PermissionCard } from "../permission-card"

const pendingPermission: DesktopPermissionRequest = {
  id: "permission-1",
  sessionId: "session-1",
  toolName: "Shell",
  payload: {},
  status: "pending",
  createdAt: 1,
  updatedAt: 1,
}

function renderPermission(toolName: string, payload: Record<string, unknown>): HTMLElement {
  const container = document.createElement("div")
  container.innerHTML = renderToStaticMarkup(
    createElement(PermissionCard, {
      permission: { ...pendingPermission, toolName, payload },
      onReply: vi.fn(),
    })
  )
  return container
}

function requestBlock(container: HTMLElement): HTMLElement {
  const block = container.querySelector<HTMLElement>('[aria-label="请求内容"]')
  expect(block).not.toBeNull()
  return block!
}

async function withInteractiveCard(
  toolName: string,
  payload: Record<string, unknown>,
  inspect: (container: HTMLElement, onReply: ReturnType<typeof vi.fn>) => Promise<void>
): Promise<void> {
  const container = document.body.appendChild(document.createElement("div"))
  const root = createRoot(container)
  const onReply = vi.fn()
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  try {
    await act(async () => root.render(createElement(PermissionCard, {
      permission: { ...pendingPermission, toolName, payload },
      onReply,
    })))
    await inspect(container, onReply)
  } finally {
    await act(async () => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  }
}

describe("PermissionCard", () => {
  it("shows the exact Computer operation before the one-time decision", () => {
    const container = renderPermission("Computer", {
      computerApproval: true,
      reason: "记事本将覆盖测试文档",
    })
    expect(container.textContent).toContain("批准这次电脑操作")
    expect(container.textContent).toContain("记事本将覆盖测试文档")
    expect(container.textContent).toContain("允许本次")
  })

  it.each([
    ["Shell", "运行命令"],
    ["Bash", "运行命令"],
    ["WebSearch", "搜索网页"],
    ["ToolSearch", "搜索工具"],
    ["Write", "写入文件"],
    ["Edit", "修改文件"],
    ["ApplyPatch", "应用文件补丁"],
    ["Read", "读取文件"],
    ["Browser", "操作浏览器"],
    ["BrowserDeveloper", "检查网页"],
    ["JobCancel", "停止任务"],
  ])("keeps the actual %s permission summary", (toolName, label) => {
    const container = renderPermission(toolName, {})
    expect(container.textContent).toContain(label)
    expect(container.textContent).toContain(toolName)
  })

  it.each([
    "shell",
    "bash",
    "BASH",
    "write",
    "edit",
    "read",
    "browser",
    "jobcancel",
    "ex_ec",
    "mcp__custom__Read",
    "constructor",
  ])("does not describe a third-party permission as a built-in operation: %s", (toolName) => {
    const container = renderPermission(toolName, {})
    expect(container.textContent).toContain("运行工具")
    expect(container.textContent).toContain(toolName)
  })

  it.each([
    ["ask_user", "需要你确认"],
    ["timed_out", "审查超时"],
  ])(
    "shows automatic review state %s and its escaped reason without expanding details",
    (status, title) => {
      const html = renderToStaticMarkup(
        createElement(PermissionCard, {
          permission: {
            id: "review",
            sessionId: "session",
            toolName: "Shell",
            status: "pending",
            payload: {
              approvalReview: { status, startedAt: 1, reason: "<script>reason</script>" },
            },
            createdAt: 1,
            updatedAt: 1,
          },
          onReply: vi.fn(),
        })
      )
      expect(html).toContain(title)
      expect(html).toContain("&lt;script&gt;reason")
      expect(html).not.toContain("<script>")
      const container = document.createElement("div")
      container.innerHTML = html
      expect(container.textContent).toContain("<script>reason</script>")
      requestBlock(container).remove()
      expect(container.textContent).toContain(title)
      expect(container.textContent).toContain("<script>reason</script>")
    }
  )

  it.each(["approved", "denied", "expired"] as const)(
    "does not render a settled %s request, regardless of review state",
    (status) => {
      for (const reviewStatus of [
        undefined,
        "reviewing",
        "ask_user",
        "timed_out",
        "approved",
        "denied",
      ]) {
        const html = renderToStaticMarkup(
          createElement(PermissionCard, {
            permission: {
              id: "review",
              sessionId: "session",
              toolName: "Shell",
              status,
              payload: reviewStatus
                ? { approvalReview: { status: reviewStatus, startedAt: 1 } }
                : {},
              createdAt: 1,
              updatedAt: 2,
            },
            onReply: vi.fn(),
          })
        )
        expect(html, "settled " + status + " with review " + reviewStatus).toBe("")
      }
    }
  )

  it.each(["reviewing", "approved", "denied"] as const)(
    "does not ask for a human decision while automatic review is %s",
    (reviewStatus) => {
      const html = renderToStaticMarkup(
        createElement(PermissionCard, {
          permission: {
            id: "review",
            sessionId: "session",
            toolName: "Shell",
            status: "pending",
            payload: {
              approvalReview: { status: reviewStatus, startedAt: 1, reason: "符合已授权任务" },
            },
            createdAt: 1,
            updatedAt: 1,
          },
          onReply: vi.fn(),
        })
      )
      expect(html).toBe("")
    }
  )

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
    expect(html).toContain("DOM 结构")
    expect(html).toContain("第三方资源")
    expect(html).toContain("允许本次")
    expect(html).not.toContain("<script>")
    expect(html).toContain("&lt;script&gt;")
  })

  it.each([undefined, "unknown_action", "constructor", "__proto__"])(
    "does not invent a scope for malformed BrowserDeveloper action %s",
    (action) => {
      const html = renderToStaticMarkup(
        createElement(PermissionCard, {
          permission: {
            id: "permission-developer-bad",
            sessionId: "session-1",
            toolName: "BrowserDeveloper",
            payload: { reason: "no known action here", input: { action } },
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
    }
  )

  it("shows the entire short WebSearch payload directly in a single content block", () => {
    const payload = { input: { query: "天气" } }
    const container = renderPermission("WebSearch", payload)
    const block = requestBlock(container)
    expect(container.querySelectorAll("pre")).toHaveLength(1)
    expect(block.querySelector("pre")?.textContent).toBe(JSON.stringify(payload, null, 2))
    expect(block.querySelector("dl, button")).toBeNull()
    expect(container.querySelector("details")).toBeNull()
  })

  it("keeps the ToolSearch request intact, including its metadata, without repeating the policy reason", async () => {
    const payload = {
      input: { query: "current weather forecast by city 武汉 天气 实时 预报", limit: 5 },
      reason: "No matching rule found",
      traceId: "request-trace",
      approvalMode: "ask",
      runtimeRevision: 3,
      inputId: "input-1",
    }
    await withInteractiveCard("ToolSearch", payload, async (container, onReply) => {
      const block = requestBlock(container)
      expect(block.querySelector("dl")).toBeNull()
      const toggle = block.querySelector("button")
      if (toggle) await act(async () => toggle.click())
      expect(block.querySelector("pre")?.textContent).toBe(JSON.stringify(payload, null, 2))
      const card = container.cloneNode(true) as HTMLElement
      requestBlock(card).remove()
      expect(card.textContent).toContain("搜索工具")
      expect(card.textContent).not.toContain(payload.reason)
      expect(card.textContent).not.toContain("未匹配到授权规则")
      expect(onReply).not.toHaveBeenCalled()
    })
  })

  it.each([null, [], "not an object", { args: [1, false], nested: { key: "value" } }])(
    "keeps unfamiliar input %j in its original JSON form",
    async (input) => {
      const payload = { input }
      await withInteractiveCard("ExternalTool", payload, async (container) => {
        const block = requestBlock(container)
        const toggle = block.querySelector("button")
        if (toggle) await act(async () => toggle.click())
        expect(JSON.parse(block.querySelector("pre")!.textContent!)).toEqual(payload)
      })
    }
  )

  it("expands and collapses the full raw request independently of its approval actions", async () => {
    const command = '  echo "<script>alert(1)</script>"\r\n' + "很长的中文参数".repeat(2500) + "正文末尾  "
    const payload = { input: { command }, reason: "<img src=x onerror=alert(1)>", traceId: "trace-1" }
    await withInteractiveCard("Shell", payload, async (container, onReply) => {
      const block = requestBlock(container)
      const raw = JSON.stringify(payload, null, 2)
      const preview = block.querySelector("pre")?.textContent
      expect(preview).toContain("echo")
      expect(container.textContent).not.toContain("正文末尾")
      expect(block.querySelectorAll("button")).toHaveLength(1)
      const toggle = block.querySelector("button")!
      expect(toggle.textContent).toBe("展开全部")
      expect(toggle.getAttribute("aria-expanded")).toBe("false")
      const decisions = [...container.querySelectorAll("button")].filter((button) => !block.contains(button))
      expect(decisions.map((button) => button.textContent)).toEqual(["拒绝", "允许本次"])

      await act(async () => toggle.click())
      expect(toggle.textContent).toBe("收起")
      expect(toggle.getAttribute("aria-expanded")).toBe("true")
      const expanded = block.querySelector("pre")!.textContent!
      expect(expanded).toBe(raw)
      expect(JSON.parse(expanded).input.command).toBe(command)
      expect(container.querySelector("script, img")).toBeNull()
      await act(async () => toggle.click())
      expect(block.querySelector("pre")?.textContent).toBe(preview)
      expect(container.textContent).not.toContain("正文末尾")
      expect(onReply).not.toHaveBeenCalled()

      await act(async () => decisions[1]!.click())
      expect(onReply).toHaveBeenNthCalledWith(1, "approved", "once")
      await act(async () => decisions[0]!.click())
      expect(onReply).toHaveBeenNthCalledWith(2, "denied")
    })
  })
})

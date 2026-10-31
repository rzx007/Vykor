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

function summaryText(container: HTMLElement): string {
  const summary = container.cloneNode(true) as HTMLElement
  summary.querySelector("details")?.remove()
  return summary.textContent ?? ""
}

describe("PermissionCard", () => {
  it.each([
    ["Shell", "运行命令"],
    ["Bash", "运行命令"],
    ["Write", "写入文件"],
    ["Edit", "修改文件"],
    ["ApplyPatch", "应用文件补丁"],
    ["Read", "读取文件"],
    ["Browser", "操作浏览器"],
    ["BrowserDeveloper", "检查网页"],
    ["JobCancel", "停止任务"],
  ])("keeps the actual %s permission summary", (toolName, label) => {
    const container = renderPermission(toolName, {})
    expect(summaryText(container)).toContain(label)
    expect(summaryText(container)).toContain(toolName)
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
    expect(summaryText(container)).toContain("运行工具")
    expect(summaryText(container)).toContain(toolName)
  })

  it.each([
    ["ask_user", "需要你确认"],
    ["timed_out", "审查超时"],
  ])("shows automatic review state %s and its escaped reason", (status, title) => {
    const html = renderToStaticMarkup(
      createElement(PermissionCard, {
        permission: {
          id: "review",
          sessionId: "session",
          toolName: "Shell",
          status: "pending",
          payload: { approvalReview: { status, startedAt: 1, reason: "<script>reason</script>" } },
          createdAt: 1,
          updatedAt: 1,
        },
        onReply: vi.fn(),
      })
    )
    expect(html).toContain(title)
    expect(html).toContain("&lt;script&gt;reason")
    expect(html).not.toContain("<script>")
  })

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

  it("keeps a shell command, its working directory, and technical reason inside collapsed details", () => {
    const container = renderPermission("Shell", {
      reason: "需要确认部署命令",
      input: { command: "pnpm deploy --tag release", workdir: "C:/projects/vykor" },
    })

    expect(container.textContent).toContain("运行命令")
    expect(container.querySelector("dl")?.textContent ?? "").toContain("pnpm deploy --tag release")
    expect(container.querySelector("dl")?.textContent ?? "").toContain("C:/projects/vykor")
    expect(summaryText(container)).not.toContain("pnpm deploy --tag release")
    expect(summaryText(container)).not.toContain("C:/projects/vykor")
    expect(summaryText(container)).not.toContain("需要确认部署命令")
    expect(container.querySelector("details")?.textContent).toContain("需要确认部署命令")
    expect(container.textContent).toContain("允许本次")
    expect(container.textContent).not.toContain("检查类别")
  })

  it.each([
    ["Write", "写入文件"],
    ["Edit", "修改文件"],
  ])(
    "shows the actual file path for %s without copying its full body into the summary",
    (toolName, summary) => {
      const container = renderPermission(toolName, {
        input: { file_path: "C:/work/config.json", content: "private file body" },
      })

      expect(container.textContent).toContain(summary)
      expect(container.querySelector("dl")?.textContent ?? "").toContain("C:/work/config.json")
      expect(container.querySelector("dl")?.textContent ?? "").not.toContain("private file body")
      expect(container.querySelector("details pre")?.textContent ?? "").toContain(
        "private file body"
      )
    }
  )

  it("shows supplied action, URL, and target fields for an unfamiliar tool without inventing a scope", () => {
    const container = renderPermission("RemoteTool", {
      input: { action: "publish", url: "https://example.org/release", target: "production" },
    })

    expect(container.querySelector("dl")?.textContent ?? "").toContain("publish")
    expect(container.querySelector("dl")?.textContent ?? "").toContain(
      "https://example.org/release"
    )
    expect(container.querySelector("dl")?.textContent ?? "").toContain("production")
    expect(container.textContent).not.toContain("整个会话")
    expect(container.textContent).not.toContain("工作目录")
  })

  it("shows a structured job target from the actual job payload", () => {
    const container = renderPermission("JobCancel", {
      input: { target: { kind: "shell", jobId: "shell-17" }, reason: "finished" },
    })

    expect(container.querySelector("dl")?.textContent ?? "").toContain("shell: shell-17")
  })

  it("preserves browser approval context when its URL exists only in the request reason", () => {
    const container = renderPermission("Browser", {
      reason: "允许访问 https://example.org/account 吗？",
      input: { action: "navigate" },
    })

    expect(summaryText(container)).not.toContain("https://example.org/account")
    expect(container.querySelector("details")?.textContent).toContain("https://example.org/account")
    expect(container.querySelector("dl")?.textContent ?? "").toContain("navigate")
    expect(container.querySelector("dl")?.textContent ?? "").not.toContain(
      "https://example.org/account"
    )
  })

  it.each([null, [], "not an object", { command: 42, workdir: {}, file_path: false, target: [] }])(
    "does not derive operation fields from malformed input %j",
    (input) => {
      const container = renderPermission("Shell", { reason: 4, input })

      expect(container.querySelector("dl")).toBeNull()
      expect(container.querySelector("details pre")?.textContent ?? "").toContain('"input"')
      expect(container.textContent).not.toContain("undefined")
      expect(container.textContent).not.toContain("[object Object]")
    }
  )

  it("keeps original details collapsed and renders hostile strings as text", () => {
    const reason = "<img src=x onerror=alert(1)>"
    const input = { command: "echo '<script>alert(1)</script>'", unknown: { nested: "original" } }
    const payload = { reason, input, traceId: "trace-1" }
    const container = renderPermission("Shell", payload)
    const details = container.querySelector("details")!

    expect(details).not.toBeNull()
    expect(details.open).toBe(false)
    expect(details.querySelector("summary")?.textContent).toContain("查看详情")
    expect(JSON.parse(details.querySelector("pre")!.textContent!)).toEqual(payload)
    expect(container.querySelector("script, img")).toBeNull()
    expect(container.querySelector("dl")?.textContent).toContain(input.command)
  })

  it("bounds long summaries and raw details while clearly marking omitted content", () => {
    const container = renderPermission("Shell", {
      reason: "reason ".repeat(500),
      input: { command: "command ".repeat(500), content: "body ".repeat(10000) },
    })

    expect(container.querySelector("dl")).not.toBeNull()
    expect(container.querySelector("details pre")).not.toBeNull()
    expect(container.querySelector("dl")!.textContent!.length).toBeLessThan(1500)
    expect(container.querySelector("details pre")!.textContent!.length).toBeLessThanOrEqual(12000)
    expect(container.querySelector("details")?.textContent ?? "").toContain("已截断")
    expect(container.textContent!.length).toBeLessThan(15000)
  })

  it("expands details without replying and retains the once-only approval and rejection callbacks", async () => {
    const container = document.createElement("div")
    document.body.append(container)
    const root = createRoot(container)
    const onReply = vi.fn()
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    try {
      await act(async () =>
        root.render(
          createElement(PermissionCard, {
            permission: { ...pendingPermission, payload: { input: { command: "pnpm deploy" } } },
            onReply,
          })
        )
      )
      const details = container.querySelector("details")!
      expect(details).not.toBeNull()
      await act(async () => details.querySelector("summary")!.click())
      expect(details.open).toBe(true)
      expect(onReply).not.toHaveBeenCalled()
      const buttons = [...container.querySelectorAll("button")]
      await act(async () => buttons.find((button) => button.textContent === "允许本次")!.click())
      expect(onReply).toHaveBeenNthCalledWith(1, "approved", "once")
      await act(async () => buttons.find((button) => button.textContent === "拒绝")!.click())
      expect(onReply).toHaveBeenNthCalledWith(2, "denied")
    } finally {
      act(() => root.unmount())
      container.remove()
      delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT
    }
  })
})

// @vitest-environment jsdom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { DesktopMcpServer } from "@shared/mcp-types"
import { McpSettings } from "./mcp-settings"

function makeServer(overrides: Partial<DesktopMcpServer> = {}): DesktopMcpServer {
  return {
    name: "linear",
    transport: "http",
    endpoint: "https://mcp.linear.app/mcp",
    authMode: "oauth",
    authStatus: "not-logged-in",
    scopes: [],
    runtimeStatus: "connected",
    ...overrides,
  }
}

function installDesktop(server: DesktopMcpServer, overrides: {
  snapshot?: ReturnType<typeof vi.fn>
  login?: ReturnType<typeof vi.fn>
  logout?: ReturnType<typeof vi.fn>
} = {}) {
  const desktop = {
    mcp: {
      snapshot: overrides.snapshot ?? vi.fn(async () => ({ servers: [server] })),
      login: overrides.login ?? vi.fn(async () => ({ servers: [server] })),
      logout: overrides.logout ?? vi.fn(async () => ({ servers: [server] })),
    },
  }
  Object.defineProperty(window, "desktop", { configurable: true, value: desktop })
  return desktop
}

describe("McpSettings", () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    ;(
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.restoreAllMocks()
  })

  async function render(): Promise<void> {
    await act(async () => {
      root.render(<McpSettings />)
    })
    await act(async () => {
      await Promise.resolve()
    })
  }

  it("shows the auth mode, credential status and runtime status, and sends explicit scopes", async () => {
    const server = makeServer()
    const login = vi.fn(async () => ({
      servers: [{ ...server, authStatus: "valid" as const, scopes: ["read"] }],
    }))
    installDesktop(server, { login })

    await render()
    expect(container.textContent).toContain("OAuth")
    expect(container.textContent).toContain("未登录")
    expect(container.textContent).toContain("Runtime 已连接")
    expect(container.textContent).toContain("多个权限请用逗号分隔")

    const input = container.querySelector<HTMLInputElement>(
      'input[aria-label="linear OAuth scopes"]'
    )!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
      setter?.call(input, "read")
      input.dispatchEvent(new Event("input", { bubbles: true }))
    })
    await act(async () => {
      Array.from(container.querySelectorAll("button"))
        .find((button) => button.textContent?.includes("浏览器授权"))
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    })
    expect(login).toHaveBeenCalledWith({ name: "linear", scopes: ["read"] })
    expect(container.textContent).toContain("已连接")
  })

  it("asks for reauthorization when the credential needs it", async () => {
    installDesktop(makeServer({ authStatus: "reauthentication-required" }))
    await render()
    expect(container.textContent).toContain("需要重新登录")
    expect(
      Array.from(container.querySelectorAll("button")).some((button) =>
        button.textContent?.includes("重新授权")
      )
    ).toBe(true)
  })

  it("treats a public HTTP server as unauthenticated without offering OAuth", async () => {
    const login = vi.fn(async () => ({ servers: [makeServer()] }))
    installDesktop(makeServer({ authMode: "none", authStatus: "not-configured" }), { login })

    await render()

    expect(container.textContent).toContain("无需认证")
    expect(container.textContent).not.toContain("未登录")
    expect(container.textContent).not.toContain("浏览器授权")
    expect(login).not.toHaveBeenCalled()
  })

  it("does not offer an OAuth login button for static credentials", async () => {
    installDesktop(makeServer({ authMode: "bearer", authStatus: "static" }))
    await render()
    expect(container.textContent).toContain("Bearer")
    expect(container.textContent).toContain("静态凭据")
    expect(container.querySelectorAll("button")).toHaveLength(0)
  })

  it("keeps the saved OAuth state and shows a warning when the runtime fails to reconnect", async () => {
    const server = makeServer()
    const snapshot = vi
      .fn()
      .mockResolvedValueOnce({ servers: [server] })
      .mockResolvedValue({ servers: [{ ...server, authStatus: "valid" as const, scopes: ["read"] }] })
    const login = vi.fn(async () => {
      throw new Error("OAuth authorization was saved for linear, but the active runtime failed to reconnect.")
    })
    installDesktop(server, { snapshot, login })

    await render()
    await act(async () => {
      Array.from(container.querySelectorAll("button"))
        .find((button) => button.textContent?.includes("浏览器授权"))
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(container.querySelector('[role="alert"]')?.textContent).toContain("重连失败")
    expect(container.textContent).toContain("已连接")
    expect(container.textContent).toContain("Runtime 已连接")
  })

  it("marks a failed runtime connection as destructive", async () => {
    installDesktop(makeServer({ runtimeStatus: "error" }))
    await render()
    expect(container.textContent).toContain("Runtime 连接失败")
  })
})

// @vitest-environment jsdom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { McpSettings } from "./mcp-settings"

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

  it("shows configured status and sends explicit scopes to browser login", async () => {
    const login = vi.fn(async () => ({
      servers: [{ ...server, authStatus: "valid" as const, scopes: ["read"] }],
    }))
    Object.defineProperty(window, "desktop", {
      configurable: true,
      value: {
        mcp: {
          snapshot: vi.fn(async () => ({ servers: [server] })),
          login,
          logout: vi.fn(),
        },
      },
    })

    await act(async () => {
      root.render(<McpSettings />)
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(container.textContent).toContain("linear")
    expect(container.textContent).toContain("未登录")
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
})

const server = {
  name: "linear",
  transport: "http" as const,
  endpoint: "https://mcp.linear.app/mcp",
  authStatus: "not-logged-in" as const,
  scopes: [],
}

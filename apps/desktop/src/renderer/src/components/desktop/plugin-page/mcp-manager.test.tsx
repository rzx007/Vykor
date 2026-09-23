// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type {
  DesktopMcpOperationResult,
  DesktopMcpServer,
  DesktopMcpSnapshot,
} from "@shared/mcp-types"
import { McpManager, type McpManagerProps } from "./mcp-manager"

function server(overrides: Partial<DesktopMcpServer> = {}): DesktopMcpServer {
  return {
    name: "linear",
    enabled: true,
    transport: "http",
    summary: "https://mcp.linear.app/mcp",
    authMode: "oauth",
    authStatus: "not-logged-in",
    scopes: [],
    runtimeStatus: "connected",
    ...overrides,
  }
}

function snapshot(...servers: DesktopMcpServer[]): DesktopMcpSnapshot {
  return { servers }
}

function operation(
  next: DesktopMcpSnapshot,
  overrides: Partial<DesktopMcpOperationResult> = {}
): DesktopMcpOperationResult {
  return { persisted: true, credentialRemoved: false, runtimeFailures: [], snapshot: next, ...overrides }
}

function installDesktop(overrides: {
  snapshot?: ReturnType<typeof vi.fn>
  getConfig?: ReturnType<typeof vi.fn>
  exportConfig?: ReturnType<typeof vi.fn>
  add?: ReturnType<typeof vi.fn>
  update?: ReturnType<typeof vi.fn>
  remove?: ReturnType<typeof vi.fn>
  setEnabled?: ReturnType<typeof vi.fn>
  login?: ReturnType<typeof vi.fn>
  logout?: ReturnType<typeof vi.fn>
} = {}) {
  const desktop = {
    mcp: {
      snapshot: overrides.snapshot ?? vi.fn(async () => snapshot(server())),
      getConfig:
        overrides.getConfig ??
        vi.fn(async () => ({ type: "http", url: "https://mcp.linear.app/mcp" })),
      exportConfig: overrides.exportConfig ?? vi.fn(async () => ({ mcpServers: {} })),
      add: overrides.add ?? vi.fn(async () => operation(snapshot(server()))),
      update: overrides.update ?? vi.fn(async () => operation(snapshot(server()))),
      remove: overrides.remove ?? vi.fn(async () => operation(snapshot())),
      setEnabled: overrides.setEnabled ?? vi.fn(async () => operation(snapshot(server()))),
      login: overrides.login ?? vi.fn(async () => snapshot(server({ authStatus: "valid" }))),
      logout: overrides.logout ?? vi.fn(async () => snapshot(server())),
    },
  }
  Object.defineProperty(window, "desktop", { configurable: true, value: desktop })
  return desktop
}

describe("MCP manager against the desktop API", () => {
  let root: Root
  let container: HTMLDivElement
  let notify: ReturnType<typeof vi.fn>

  beforeEach(() => {
    ;(
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true
    localStorage.clear()
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
    notify = vi.fn()
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.restoreAllMocks()
    delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT
  })

  async function render(next: Partial<McpManagerProps> = {}): Promise<void> {
    const props: McpManagerProps = {
      query: "",
      addRequest: 0,
      refreshRequest: 0,
      notify,
      ...next,
    }
    await act(async () => root.render(<McpManager {...props} />))
    await act(async () => {
      await Promise.resolve()
    })
  }
  async function click(label: string): Promise<void> {
    const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (item) => item.textContent?.trim() === label || item.getAttribute("aria-label") === label
    )
    expect(button, `button: ${label}`).toBeTruthy()
    await act(async () => {
      button!.click()
      await Promise.resolve()
    })
  }
  async function input(selector: string, value: string): Promise<void> {
    const element = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!
    expect(element).toBeTruthy()
    const prototype =
      element.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    await act(async () => {
      Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value)
      element.dispatchEvent(new Event("input", { bubbles: true }))
    })
  }
  function rows(): Element[] {
    return [...container.querySelectorAll("[data-extension-row]")]
  }

  it("shows globally configured servers and never reads the old localStorage demo data", async () => {
    localStorage.setItem(
      'openharness:mcp:local:v1:"D:/project"',
      JSON.stringify({
        version: 1,
        document: {
          servers: [{ name: "demo-only", config: { type: "stdio", command: "node" } }],
          extras: {},
          wrapped: true,
        },
      })
    )
    const desktop = installDesktop({
      snapshot: vi.fn(async () =>
        snapshot(
          server({ name: "linear" }),
          server({ name: "beui", transport: "stdio", summary: "npx beui", authMode: "none" })
        )
      ),
    })

    await render()

    expect(desktop.mcp.snapshot).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain("linear")
    expect(container.textContent).toContain("beui")
    expect(container.textContent).not.toContain("demo-only")
  })

  it("filters and searches the global list", async () => {
    installDesktop({
      snapshot: vi.fn(async () =>
        snapshot(
          server({ name: "alpha" }),
          server({ name: "beta", enabled: false, summary: "https://beta.test/mcp" })
        )
      ),
    })
    await render()

    await click("已停用")
    expect(rows()).toHaveLength(1)
    expect(rows()[0]?.textContent).toContain("beta")

    await click("全部")
    await render({ query: "alpha" })
    expect(rows()).toHaveLength(1)
    expect(rows()[0]?.textContent).toContain("alpha")
  })

  it("toggles a server through the API and applies the returned snapshot", async () => {
    const desktop = installDesktop({
      snapshot: vi.fn(async () => snapshot(server({ name: "alpha" }))),
      setEnabled: vi.fn(async () => operation(snapshot(server({ name: "alpha", enabled: false })))),
    })
    await render()

    const toggle = container.querySelector<HTMLButtonElement>('[role="switch"]')!
    await act(async () => {
      toggle.click()
      await Promise.resolve()
    })

    expect(desktop.mcp.setEnabled).toHaveBeenCalledWith({ name: "alpha", enabled: false })
    expect(container.textContent).toContain("已停用")
  })

  it("reports a saved-but-not-synced operation as a partial success", async () => {
    installDesktop({
      snapshot: vi.fn(async () => snapshot(server({ name: "alpha" }))),
      setEnabled: vi.fn(async () =>
        operation(snapshot(server({ name: "alpha", enabled: false })), {
          runtimeFailures: [{ runtimeId: "runtime-1", message: "reconnect failed" }],
        })
      ),
    })
    await render()

    const toggle = container.querySelector<HTMLButtonElement>('[role="switch"]')!
    await act(async () => {
      toggle.click()
      await Promise.resolve()
    })

    expect(notify).toHaveBeenCalledWith(expect.stringContaining("同步到活动会话失败"))
  })

  it("shows OAuth actions only for OAuth HTTP servers", async () => {
    installDesktop({
      snapshot: vi.fn(async () =>
        snapshot(
          server({ name: "linear", transport: "http", authMode: "oauth", authStatus: "not-logged-in" }),
          server({ name: "beui", transport: "stdio", authMode: "none", summary: "npx beui" })
        )
      ),
    })
    await render()

    await click("查看 beui 的 MCP 配置")
    expect(document.body.textContent).toContain("无需认证")
    expect(
      [...document.querySelectorAll("button")].some((item) =>
        ["浏览器授权", "重新授权", "退出登录"].includes(item.textContent?.trim() ?? "")
      )
    ).toBe(false)

    await click("查看 linear 的 MCP 配置")
    expect(document.body.textContent).toContain("浏览器授权")
  })

  it("refreshes the snapshot after an OAuth login", async () => {
    const desktop = installDesktop({
      snapshot: vi.fn(async () =>
        snapshot(server({ name: "linear", authMode: "oauth", authStatus: "not-logged-in" }))
      ),
      login: vi.fn(async () => snapshot(server({ name: "linear", authMode: "oauth", authStatus: "valid" }))),
    })
    await render()

    await click("查看 linear 的 MCP 配置")
    await click("浏览器授权")

    expect(desktop.mcp.login).toHaveBeenCalledWith({ name: "linear", scopes: [] })
    expect(document.body.textContent).toContain("已授权")
  })

  it("adds a server through the editor using a real config", async () => {
    const desktop = installDesktop({
      snapshot: vi.fn(async () => snapshot()),
    })
    await render()
    await render({ addRequest: 1 })

    await input('input[id$="-name"]', "beui")
    await input('input[id$="-command"]', "npx")
    await click("保存")

    expect(desktop.mcp.add).toHaveBeenCalledWith({
      name: "beui",
      config: { type: "stdio", command: "npx" },
    })
  })

  it("exports the real global config from the desktop API", async () => {
    const desktop = installDesktop({
      exportConfig: vi.fn(async () => ({
        mcpServers: { linear: { type: "http", url: "https://mcp.linear.app/mcp" } },
      })),
    })
    await render()

    await click("导出 JSON")

    expect(desktop.mcp.exportConfig).toHaveBeenCalledTimes(1)
    expect(document.querySelector<HTMLTextAreaElement>("#mcp-export-json")?.value).toContain(
      "mcp.linear.app"
    )
  })
})

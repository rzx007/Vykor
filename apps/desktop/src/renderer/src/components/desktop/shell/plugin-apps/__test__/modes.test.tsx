// @vitest-environment jsdom
import { act, StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { PluginAppPageManager, canUseAppSidebar } from "../page-manager"
import { PluginAppTransport } from "../transport"
import { PluginAppFrame } from "../frame"
import { PluginAppCatalog } from "../panel"
import { PluginAppToolResultEntry } from "../tool-result-entry"
import { mount } from "./fixtures.test-support"
import type { DesktopSessionPart } from "@shared/session-types"
const state = vi.hoisted(() => ({ manager: undefined as PluginAppPageManager | undefined, bridges: [] as any[], modes: undefined as string[] | undefined }))
vi.mock("../provider", () => ({ usePluginApps: () => state.manager, usePluginAppPages: () => state.manager?.snapshot() ?? [] }))
vi.mock("@modelcontextprotocol/ext-apps/app-bridge", () => ({ AppBridge: class {
  oninitialized?: () => void
  onrequestdisplaymode?: (input: { mode: string }) => Promise<unknown>
  contexts: any[] = []; inputs: unknown[] = []; results: unknown[] = []
  connect = vi.fn(async () => {}); close = vi.fn(async () => {})
  constructor(_client: unknown, _info: unknown, _capabilities: unknown, options: { hostContext: unknown }) { this.contexts.push(options.hostContext); state.bridges.push(this) }
  getAppCapabilities() { return { availableDisplayModes: state.modes } }
  setRequestHandler() {}
  setHostContext(context: unknown) { this.contexts.push(context) }
  async sendToolInput(input: unknown) { this.inputs.push(input) }
  async sendToolResult(result: unknown) { this.results.push(result) }
  async teardownResource() {}
} }))
beforeEach(() => { Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true) })
afterEach(() => { Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT"); state.bridges = []; state.manager = undefined; state.modes = undefined; vi.useRealTimers() })
function fixture() {
  const localMount = { ...mount, url: "about:blank" }
  const api = { open: vi.fn(async () => localMount), mount: async () => localMount, release: vi.fn(async () => {}), rejectMenuOpen: vi.fn(async () => ({ closed: true })),
    openToolResult: async ({ sourcePartId }: { sourcePartId: string }) => ({ mounted: localMount, initial: { sourcePartId, arguments: {}, result: { content: [] } } }) }
  const manager = new PluginAppPageManager(api as never, async () => true)
  state.manager = manager
  return { api, manager }
}
it.each([undefined, ["inline"]])("keeps %j modes at the tool-result inline Anchor and out of sidebar eligibility", async modes => {
  state.modes = modes
  const { manager } = fixture(), container = document.createElement("div")
  document.body.append(container); const root = createRoot(container)
  const part: DesktopSessionPart = { id: "part", sessionId: "original", messageId: "message", seq: 0, createdAt: 1, updatedAt: 1, type: "tool", status: "completed", metadata: { pluginAppSource: {} } }
  await act(async () => root.render(<PluginAppToolResultEntry part={part} />))
  await act(async () => container.querySelector("button")!.click())
  const page = manager.snapshot()[0]!, anchor = Symbol()
  expect(container.querySelector('[aria-label="插件应用显示区域"]')).not.toBeNull()
  page.element = document.createElement("div")
  page.transport = new PluginAppTransport(document.createElement("iframe"), page.controller, page)
  manager.place(page.id, new DOMRect(10, 20, 300, 200), anchor)
  expect(page.element.style.visibility).toBe("hidden")
  state.bridges[0].oninitialized()
  expect(page.element.style.visibility).toBe("visible")
  expect(manager.snapshot().filter(canUseAppSidebar)).toEqual([])
  expect(state.bridges[0].contexts.at(-1)).toMatchObject({ displayMode: "inline", availableDisplayModes: ["inline"] })
  await expect(state.bridges[0].onrequestdisplaymode({ mode: "fullscreen" })).rejects.toThrow("display_mode_unavailable")
  await expect(state.bridges[0].onrequestdisplaymode({ mode: "pip" })).rejects.toThrow("display_mode_unavailable")
  await expect(manager.open("original", "example", "editor", "Editor")).rejects.toThrow("仅支持内联")
  expect(manager.snapshot()).toEqual([page])
  await act(async () => root.unmount()); container.remove()
})
it("negotiates sidebar placement, hides and returns inline with the same frame, window, draft and one handshake", async () => {
  state.modes = ["inline", "fullscreen"]
  const { manager } = fixture(), page = await manager.mount(mount.state.source, "Editor")
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container)
  await act(async () => root.render(<StrictMode><PluginAppFrame page={page} /></StrictMode>))
  const frame = container.querySelector("iframe")!, peer = frame.contentWindow!, bridge = state.bridges[0]
  peer.document.body.innerHTML = '<input value="retained draft">'
  bridge.oninitialized()
  const inline = Symbol(), sidebar = Symbol()
  manager.place(page.id, new DOMRect(10, 20, 300, 200), inline)
  expect(bridge.contexts.at(-1).displayMode).toBe("inline")
  manager.place(page.id, new DOMRect(400, 20, 200, 600), sidebar, "fullscreen")
  expect(bridge.contexts.at(-1).displayMode).toBe("fullscreen")
  expect(page.element!.style.left).toBe("400px")
  expect(page.element!.style.width).toBe("200px")
  manager.place(page.id, null, sidebar, "fullscreen"); manager.place(page.id, null, inline)
  expect(page.element!.style.visibility).toBe("hidden")
  manager.place(page.id, new DOMRect(10, 20, 300, 200), inline)
  expect(bridge.contexts.at(-1).displayMode).toBe("inline")
  await expect(bridge.onrequestdisplaymode({ mode: "fullscreen" })).resolves.toEqual({ mode: "fullscreen" })
  expect(page.element!.style.left).toBe("0px")
  await expect(bridge.onrequestdisplaymode({ mode: "inline" })).resolves.toEqual({ mode: "inline" })
  expect(page.element!.style.left).toBe("10px")
  manager.releaseAnchor(page.id, inline)
  manager.place(page.id, new DOMRect(400, 20, 200, 600), sidebar, "fullscreen")
  await expect(bridge.onrequestdisplaymode({ mode: "inline" })).rejects.toThrow("display_mode_unavailable")
  expect(canUseAppSidebar(page)).toBe(true)
  expect(frame.contentWindow).toBe(peer); expect(peer.document.querySelector("input")!.value).toBe("retained draft")
  expect(state.bridges).toHaveLength(1); expect(bridge.connect).toHaveBeenCalledTimes(1)
  await act(async () => root.unmount()); container.remove()
})
it.each(["inline", "timeout", "connect-error"])("releases a hidden direct-menu viewer on %s after Main confirms safe durable cleanup", async kind => {
  vi.useFakeTimers()
  const { api, manager } = fixture()
  const pending = manager.open("original", "example", "editor", "Editor")
  const failed = expect(pending).rejects.toThrow(kind === "inline" ? "仅支持内联" : kind === "timeout" ? "超时" : "初始化失败")
  await Promise.resolve(); const page = manager.snapshot()[0]!
  expect(canUseAppSidebar(page)).toBe(false)
  expect(() => page.controller.assertInteraction()).toThrow("隐藏")
  if (kind === "inline") page.onModes!(["inline"])
  else if (kind === "connect-error") page.onInitializationError!(new Error("connect failed"))
  else await vi.advanceTimersByTimeAsync(10_001)
  await failed
  expect(api.rejectMenuOpen).toHaveBeenCalledWith({ mountId: page.id })
  expect(api.release).toHaveBeenCalledWith({ mountId: page.id }); expect(manager.snapshot()).toEqual([])
})
it("completes direct-menu opening only after fullscreen is confirmed", async () => {
  const { manager } = fixture()
  const pending = manager.open("original", "example", "editor", "Editor")
  await Promise.resolve(); const page = manager.snapshot()[0]!
  expect(canUseAppSidebar(page)).toBe(false)
  page.onModes!(["inline", "fullscreen"])
  expect(await pending).toBe(page); expect(canUseAppSidebar(page)).toBe(true)
})
it("transfers pending bodies to transport then releases them after one delivery per source Part", async () => {
  const { manager } = fixture(), page = await manager.openToolResult("original", "a")
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container)
  expect(page.results!.size).toBe(1)
  await act(async () => root.render(<PluginAppFrame page={page} />))
  expect(page.results!.size).toBe(0)
  const bridge = state.bridges[0]; bridge.oninitialized()
  await manager.openToolResult("original", "b"); await manager.openToolResult("original", "a"); await manager.openToolResult("original", "b")
  await vi.waitFor(() => expect(bridge.results).toHaveLength(2))
  expect(bridge.inputs).toHaveLength(2)
  expect(page.results!.size).toBe(0); expect([...page.sourceParts!]).toEqual(["a", "b"])
  expect((page.transport as unknown as { results: unknown[] }).results).toEqual([])
  await act(async () => root.unmount()); container.remove()
})

it("keeps rejected shared/changed apps reachable in the catalog for explicit close", async () => {
  const { api, manager } = fixture()
  api.rejectMenuOpen.mockResolvedValue({ closed: false })
  Object.assign(api, { catalog: async () => ({ backends: [] }), close: vi.fn(async () => ({ app: { ...mount.state.app, status: "closed" } })) })
  const pending = manager.open("original", "example", "editor", "Editor")
  const rejected = expect(pending).rejects.toThrow("仅支持内联")
  await Promise.resolve(); const page = manager.snapshot()[0]!
  page.onModes!(["inline"]); await rejected
  expect(manager.snapshot()).toEqual([page]); expect(page.menuRejection).toBeTruthy()
  expect(api.release).not.toHaveBeenCalled()
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container)
  await act(async () => root.render(<PluginAppCatalog sessionId="original" onSelect={() => {}} />))
  const close = [...container.querySelectorAll("button")].find(button => button.textContent === "关闭应用并释放名额")!
  expect(close).toBeTruthy(); expect(container.textContent).toContain("关闭会影响共享此应用的窗口")
  await act(async () => close.click())
  expect(manager.snapshot()).toEqual([])
  await act(async () => root.unmount()); container.remove()
})

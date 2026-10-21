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
  const api = { catalog: async () => ({ backends: [{ pluginId: "example", backendId: "editor", surfaces: [{ id: "editor", title: "笔记", resourceUri: "ui://editor" }] }] }), open: vi.fn(async () => localMount), mount: async () => localMount, release: vi.fn(async () => {}), rejectMenuOpen: vi.fn(async () => ({ closed: true })),
    openToolResult: async ({ sourcePartId }: { sourcePartId: string }) => ({ mounted: localMount, initial: { sourcePartId, arguments: {}, result: { content: [] } } }) }
  const manager = new PluginAppPageManager(api as never, async () => true)
  state.manager = manager
  return { api, manager }
}
it.each([undefined, ["inline"]])("opens %j apps only in the fixed panel without a chat iframe", async modes => {
  state.modes = modes
  const { manager } = fixture(), container = document.createElement("div")
  document.body.append(container); const root = createRoot(container)
  const part: DesktopSessionPart = { id: "part", sessionId: "original", messageId: "message", seq: 0, createdAt: 1, updatedAt: 1, type: "tool", status: "completed", metadata: { pluginAppSource: { pluginId: "example", backendId: "editor", resourceUri: "ui://editor" } } }
  await act(async () => root.render(<PluginAppToolResultEntry part={part} />))
  expect(manager.snapshot()).toEqual([]) // Historical rendering never opens an application.
  expect(container.textContent).toContain("查看笔记")
  await act(async () => container.querySelector("button")!.click())
  const page = manager.snapshot()[0]!, anchor = Symbol()
  expect(container.querySelector('[aria-label="插件应用显示区域"]')).toBeNull()
  expect(container.querySelector("iframe")).toBeNull()
  expect(manager.panelRequest).toMatchObject({ pageId: page.id, sessionId: "original" })
  page.element = document.createElement("div")
  page.transport = new PluginAppTransport(document.createElement("iframe"), page.controller, page)
  manager.place(page.id, new DOMRect(400, 20, 300, 600), anchor)
  expect(page.element.style.visibility).toBe("hidden")
  state.bridges[0].oninitialized()
  expect(page.element.style.visibility).toBe("visible")
  expect(manager.snapshot().filter(canUseAppSidebar)).toEqual([page])
  expect(state.bridges[0].contexts.at(-1)).toMatchObject({ displayMode: "inline", availableDisplayModes: ["inline"] })
  await expect(state.bridges[0].onrequestdisplaymode({ mode: "fullscreen" })).rejects.toThrow("display_mode_unavailable")
  await act(async () => root.unmount()); container.remove()
})
it("retains frame, window and draft across panel switches and constrains display modes to its panel", async () => {
  state.modes = ["inline", "fullscreen"]
  const { manager } = fixture(), page = await manager.mount(mount.state.source, "Editor")
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container)
  await act(async () => root.render(<StrictMode><PluginAppFrame page={page} /></StrictMode>))
  const frame = container.querySelector("iframe")!, peer = frame.contentWindow!, bridge = state.bridges[0]
  peer.document.body.innerHTML = '<input value="retained draft">'
  bridge.oninitialized()
  const anchor = Symbol(), rect = new DOMRect(400, 20, 300, 600)
  manager.place(page.id, rect, anchor)
  expect(bridge.contexts.at(-1).displayMode).toBe("inline")
  await expect(bridge.onrequestdisplaymode({ mode: "fullscreen" })).resolves.toEqual({ mode: "fullscreen" })
  expect(page.element!.style.left).toBe("400px")
  expect(page.element!.style.width).toBe("300px")
  await expect(bridge.onrequestdisplaymode({ mode: "inline" })).resolves.toEqual({ mode: "inline" })
  manager.place(page.id, null, anchor)
  expect(page.element!.style.visibility).toBe("hidden")
  manager.place(page.id, rect, anchor)
  expect(canUseAppSidebar(page)).toBe(true)
  expect(frame.contentWindow).toBe(peer); expect(peer.document.querySelector("input")!.value).toBe("retained draft")
  expect(state.bridges).toHaveLength(1); expect(bridge.connect).toHaveBeenCalledTimes(1)
  await act(async () => root.unmount()); container.remove()
})
it.each(["timeout", "connect-error"])("cleans up a failed menu load on %s only after Main confirms safe cleanup", async kind => {
  vi.useFakeTimers()
  const { api, manager } = fixture()
  const pending = manager.open("original", "example", "editor", "Editor")
  const failed = expect(pending).rejects.toThrow(kind === "timeout" ? "超时" : "初始化失败")
  await Promise.resolve(); const page = manager.snapshot()[0]!
  expect(() => page.controller.assertInteraction()).toThrow("隐藏")
  if (kind === "connect-error") page.onInitializationError!(new Error("connect failed"))
  else await vi.advanceTimersByTimeAsync(10_001)
  await failed
  expect(api.rejectMenuOpen).toHaveBeenCalledWith({ mountId: page.id })
  expect(api.release).toHaveBeenCalledWith({ mountId: page.id }); expect(manager.snapshot()).toEqual([])
})
it("allows an inline-only app from the catalog after the public handshake", async () => {
  const { manager } = fixture()
  const pending = manager.open("original", "example", "editor", "Editor")
  await Promise.resolve(); const page = manager.snapshot()[0]!
  expect(canUseAppSidebar(page)).toBe(false)
  page.onModes!(["inline"])
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
  const rejected = expect(pending).rejects.toThrow("初始化失败")
  await Promise.resolve(); const page = manager.snapshot()[0]!
  page.onInitializationError!(new Error("failed")); await rejected
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

it("updates live results once without taking focus from an existing application", async () => {
  const { manager } = fixture()
  const page = await manager.presentToolResult("original", "first", true)
  expect(manager.panelRequest?.pageId).toBe(page!.id)
  const firstRequest = manager.panelRequest
  const queueToolResult = vi.fn()
  page!.transport = { queueToolResult } as never
  await manager.presentToolResult("original", "next", true)
  await manager.presentToolResult("original", "next", true)
  expect(queueToolResult).toHaveBeenCalledTimes(1)
  expect(manager.panelRequest).toBe(firstRequest)
  await manager.presentToolResult("original", "next")
  expect(manager.panelRequest!.sequence).toBeGreaterThan(firstRequest!.sequence)
  expect(queueToolResult).toHaveBeenCalledTimes(1)
})

it("viewing an older result only focuses a surface already opened from the catalog", async () => {
  const { manager } = fixture(), page = await manager.mount(mount.state.source, "笔记")
  const queueToolResult = vi.fn()
  page.transport = { queueToolResult } as never
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container)
  const part: DesktopSessionPart = { id: "old-part", sessionId: "original", messageId: "message", seq: 0, createdAt: 1, updatedAt: 1, type: "tool", status: "completed", metadata: { pluginAppSource: { ...mount.state.app } } }
  await act(async () => root.render(<PluginAppToolResultEntry part={part} />))
  await act(async () => container.querySelector("button")!.click())
  expect(manager.panelRequest).toMatchObject({ pageId: page.id })
  expect(queueToolResult).not.toHaveBeenCalled()
  expect(page.sourceParts?.size).toBe(0)
  expect(container.textContent).toContain("已在右侧面板打开")
  expect(container.querySelector("iframe")).toBeNull()
  await act(async () => root.unmount()); container.remove()
})
it("lets Main resolve a result when multiple surfaces share the same resource", async () => {
  const { api, manager } = fixture(), menuPage = await manager.mount(mount.state.source, "目录笔记")
  const queueToolResult = vi.fn(); menuPage.transport = { queueToolResult } as never
  const openToolResult = vi.fn(async ({ sourcePartId }: { sourcePartId: string }) => ({
    mounted: { ...mount, mountId: "distinct-result", state: { ...mount.state, app: { ...mount.state.app, id: "result-app" } } },
    initial: { sourcePartId, arguments: {}, result: { content: [] } },
  }))
  Object.assign(api, { openToolResult, catalog: async () => ({ backends: [{ pluginId: "example", backendId: "editor", surfaces: [
    { id: "editor", title: "目录笔记", resourceUri: "ui://editor" },
    { id: "other", title: "其他笔记", resourceUri: "ui://editor" },
  ] }] }) })
  const part: DesktopSessionPart = { id: "distinct-part", sessionId: "original", messageId: "message", seq: 0, createdAt: 1, updatedAt: 1, type: "tool", status: "completed", metadata: { pluginAppSource: { ...mount.state.app } } }
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container)
  await act(async () => root.render(<PluginAppToolResultEntry part={part} />))
  expect(container.textContent).not.toContain("已在右侧面板打开")
  await act(async () => container.querySelector("button")!.click())
  expect(openToolResult).toHaveBeenCalledWith({ sessionId: "original", sourcePartId: part.id })
  expect(manager.panelRequest?.pageId).toBe("distinct-result")
  expect(manager.snapshot()).toHaveLength(2)
  expect(manager.snapshot()[1]!.results?.has(part.id)).toBe(true)
  expect(queueToolResult).not.toHaveBeenCalled()
  await act(async () => root.unmount()); container.remove()
})
it("title lookups cannot reorder trusted results", async () => {
  const { api, manager } = fixture()
  const page = await manager.mount(mount.state.source, "Editor"), delivered: string[] = []
  page.transport = { queueToolResult: ({ sourcePartId }: { sourcePartId: string }) => delivered.push(sourcePartId) } as never
  let finishFirst!: (value: any) => void
  let finishSecond!: (value: any) => void
  api.catalog = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finishFirst = resolve })).mockImplementationOnce(() => new Promise(resolve => { finishSecond = resolve }))
  await manager.openToolResult("original", "older")
  await manager.openToolResult("original", "newer")
  expect(delivered).toEqual(["older", "newer"])
  finishSecond({ backends: [] }); finishFirst({ backends: [] })
  await Promise.resolve()
  expect(delivered).toEqual(["older", "newer"])
})

it("does not focus another session when an asynchronous open finishes after switching chats", async () => {
  const { manager } = fixture()
  manager.setActiveSession("other-session")
  await manager.presentToolResult("original", "delayed-result", true)
  expect(manager.snapshot()).toHaveLength(1)
  expect(manager.panelRequest).toBeUndefined()
  manager.setActiveSession("original")
  expect(manager.panelRequest).toBeUndefined()
  manager.focus(manager.snapshot()[0]!)
  expect(manager.panelRequest).toMatchObject({ sessionId: "original" })
})
it("an explicit open that discovers an already mounted page does not deliver an old body", async () => {
  const { manager } = fixture(), page = await manager.mount(mount.state.source, "笔记")
  const queueToolResult = vi.fn(); page.transport = { queueToolResult } as never
  await manager.presentToolResult("original", "historical-part")
  expect(queueToolResult).not.toHaveBeenCalled()
  expect(manager.panelRequest?.pageId).toBe(page.id)
})

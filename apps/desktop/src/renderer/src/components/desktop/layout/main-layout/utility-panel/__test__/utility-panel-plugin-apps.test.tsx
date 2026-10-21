// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { DesktopPluginAppsAPI, PluginAppMount } from "@shared/plugin-app-types"
import { useDesktopSessionStore } from "@renderer/stores/desktop-session"
import { emptySessionView } from "@renderer/stores/desktop-session/store-test-fixtures"
import { PluginAppsProvider, usePluginApps } from "@renderer/components/desktop/shell/plugin-apps/provider"
import type { PluginAppPageManager } from "@renderer/components/desktop/shell/plugin-apps/page-manager"
import { mount } from "@renderer/components/desktop/shell/plugin-apps/__test__/fixtures.test-support"
import { UtilityPanel } from "../utility-panel"

const bridges = vi.hoisted(() => [] as Array<{ oninitialized?: () => void }>)
vi.mock("@modelcontextprotocol/ext-apps/app-bridge", () => ({ AppBridge: class {
  oninitialized?: () => void
  constructor() { bridges.push(this) }
  connect = vi.fn(async () => {})
  close = vi.fn(async () => {})
  getAppCapabilities() { return { availableDisplayModes: ["inline", "fullscreen"] } }
  setRequestHandler() {}
  setHostContext() {}
  async teardownResource() {}
} }))
vi.mock("@renderer/hooks/use-active-workspace-is-git", () => ({ useActiveWorkspaceIsGit: () => false }))
vi.hoisted(() => { HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext })

const initialStore = useDesktopSessionStore.getState()
let container: HTMLDivElement, root: Root, manager: PluginAppPageManager
let renderedSession: string, renderedOpen: boolean
let calls: ReturnType<typeof createAPI>
const animationFrames = new Map<number, FrameRequestCallback>()
async function paint() {
  await act(async () => {
    for (const [id, callback] of [...animationFrames]) {
      if (animationFrames.delete(id)) callback(performance.now())
    }
  })
}

function createAPI() {
  const mounts = new Map<string, PluginAppMount>()
  return {
    mounts,
    mount: vi.fn(async (source: { sessionId: string; appId: string }) => {
      const mounted = { ...mount, mountId: `${source.sessionId}:${source.appId}`, url: "about:blank", state: {
        ...mount.state, source, app: { ...mount.state.app, id: source.appId, sessionId: source.sessionId },
      } }
      mounts.set(mounted.mountId, mounted)
      return mounted
    }),
    refresh: vi.fn(async ({ mountId }: { mountId: string }) => mounts.get(mountId)!.state),
    release: vi.fn(async () => {}), close: vi.fn(async () => {}), onRevoked: () => () => {},
    prepareTool: vi.fn(async () => ({ requestId: "save", toolName: "save", args: { text: "draft" }, expectedRevision: 2 })),
    invokeTool: vi.fn(async () => ({ receipt: { status: "completed", executionState: "completed" }, result: { content: [] } })),
    cancelTool: vi.fn(async () => {}), getAction: vi.fn(),
  }
}
function Panel({ sessionId, open }: { sessionId: string; open: boolean }) {
  manager = usePluginApps()!
  return <UtilityPanel key={sessionId} scopeId={`session:${sessionId}`} open={open} maximized={false}
    onToggleMaximized={() => {}} onClose={() => {}} fileOpenRequest={null} reviewOpenRequest={null}
    terminalOpenRequest={null} toolOpenRequest={null} onOpenFile={() => {}} onOpenReview={() => {}} onOpenTerminal={() => {}} />
}
async function render(sessionId = renderedSession, open = renderedOpen) {
  renderedSession = sessionId; renderedOpen = open
  await act(async () => {
    useDesktopSessionStore.setState({ activeSessionId: sessionId, sessionView: emptySessionView(sessionId) })
    root.render(<PluginAppsProvider><Panel sessionId={sessionId} open={open} /></PluginAppsProvider>)
  })
  await paint()
}
function frame(id: string) { return container.querySelector<HTMLIFrameElement>(`[data-plugin-app-mount="${id}"] iframe`)! }
function assertVisible(id: string, visible: boolean) {
  expect(container.querySelector<HTMLElement>(`[data-plugin-app-mount="${id}"]`)!.style.visibility).toBe(visible ? "visible" : "hidden")
}
async function openPage(sessionId: string, appId: string) {
  let page!: Awaited<ReturnType<PluginAppPageManager["mount"]>>
  await act(async () => { page = await manager.mount({ sessionId, appId }, appId) })
  await act(async () => { bridges.at(-1)!.oninitialized!(); manager.focus(page) })
  await paint()
  return page
}
beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)
  useDesktopSessionStore.setState(initialStore, true)
  calls = createAPI(); bridges.length = 0
  Object.defineProperty(window, "desktop", { configurable: true, value: { pluginApps: calls as unknown as DesktopPluginAppsAPI } })
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return this.getAttribute("aria-label") === "插件应用显示区域" ? new DOMRect(500, 60, 400, 600) : new DOMRect()
  })
  let sequence = 0
  animationFrames.clear()
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { animationFrames.set(++sequence, callback); return sequence })
  vi.stubGlobal("cancelAnimationFrame", (id: number) => { animationFrames.delete(id) })
  container = document.createElement("div"); document.body.append(container); root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove(); useDesktopSessionStore.setState(initialStore, true)
  vi.restoreAllMocks(); vi.unstubAllGlobals()
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT")
})

it("keeps each frame, window and draft through actual tab, collapse and session switches", async () => {
  await render("original", true)
  const first = await openPage("original", "first"), firstFrame = frame(first.id), peer = firstFrame.contentWindow!
  peer.document.body.innerHTML = '<textarea>未保存草稿</textarea>'
  assertVisible(first.id, true)
  const second = await openPage("original", "second"), secondFrame = frame(second.id)
  assertVisible(first.id, false); assertVisible(second.id, true)
  await act(async () => { [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.title === "first")!.click() })
  await paint()
  assertVisible(first.id, true); assertVisible(second.id, false)
  await render("original", false)
  assertVisible(first.id, false)
  await expect(first.controller.callTool("save", {}, new AbortController().signal)).rejects.toThrow("隐藏")
  expect(calls.prepareTool).not.toHaveBeenCalled()
  await render("original", true)
  assertVisible(first.id, true)
  await render("another", true)
  assertVisible(first.id, false); assertVisible(second.id, false)
  await render("original", true)
  assertVisible(first.id, true)
  expect(frame(first.id)).toBe(firstFrame); expect(firstFrame.contentWindow).toBe(peer)
  expect(peer.document.querySelector("textarea")!.value).toBe("未保存草稿")
  expect(frame(second.id)).toBe(secondFrame)
  expect(calls.mount).toHaveBeenCalledTimes(2)
  expect(calls.release).not.toHaveBeenCalled(); expect(calls.close).not.toHaveBeenCalled()
})

it("cancels hidden confirmations but lets an accepted original operation finish while collapsed", async () => {
  await render("confirmations", true)
  const page = await openPage("confirmations", "editor")
  let pending!: ReturnType<typeof page.controller.callTool>
  await act(async () => { pending = page.controller.callTool("save", {}, new AbortController().signal) })
  const cancelled = expect(pending).rejects.toThrow("取消")
  await render("confirmations", false)
  await cancelled
  expect(calls.cancelTool).toHaveBeenCalledWith({ mountId: page.id, requestId: "save" })
  expect(calls.invokeTool).not.toHaveBeenCalled()
  expect(document.querySelector('[role="alertdialog"]')).toBeNull()
  await render("confirmations", true)
  calls.cancelTool.mockClear()
  let finish!: (value: Awaited<ReturnType<typeof calls.invokeTool>>) => void
  calls.invokeTool.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  await act(async () => { pending = page.controller.callTool("save", {}, new AbortController().signal) })
  await act(async () => { [...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')].find(button => button.textContent === "执行")!.click() })
  await render("confirmations", false)
  await act(async () => { finish({ receipt: { status: "completed", executionState: "completed" }, result: { content: [] } }); await pending })
  expect(calls.invokeTool).toHaveBeenCalledExactlyOnceWith({ mountId: page.id, requestId: "save" })
  expect(calls.cancelTool).not.toHaveBeenCalled()
  expect(calls.release).not.toHaveBeenCalled(); expect(calls.close).not.toHaveBeenCalled()
})

// @vitest-environment jsdom
import { act, StrictMode } from "react"
import { MessageChannel } from "node:worker_threads"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { useDesktopSessionStore } from "@renderer/stores/desktop-session"
import { emptySessionView } from "@renderer/stores/desktop-session/store-test-fixtures"
import { resetWorkspaceGitProbeCacheForTests } from "@renderer/lib/workspace-git-probe"
import { PluginUiProvider } from "@renderer/components/desktop/conversation-page/plugin-ui/plugin-ui-provider"
import { PluginUiCard } from "@renderer/components/desktop/conversation-page/plugin-ui/plugin-ui-card"
import { instance, snapshot, sourcePart, mountId } from "@renderer/components/desktop/conversation-page/plugin-ui/__test__/plugin-ui-fixtures.test-support"
import { UtilityPanel } from "../utility-panel"
vi.mock("@renderer/components/desktop/image-viewer/image-viewer-panel", () => ({ ImageViewerPanel: () => null }))
vi.hoisted(() => {
  // Importing the native terminal probes Canvas; this suite does not use a terminal.
  HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext
})
const initialState = useDesktopSessionStore.getState()
let root: Root, container: HTMLDivElement, mounts: number, unmounts: string[], dismissals: number, sidebarOpen: number
let scopeId: string, scopeSequence = 0
const sidebar = { ...instance, surface: "session-sidebar" as const }
async function render(open = true, image = false) {
  await act(async () => root.render(<StrictMode><PluginUiProvider onOpenSidebar={() => { sidebarOpen++ }}>
    <PluginUiCard instance={sidebar} call={{ ...sourcePart, metadata: { pluginUi: sidebar } }} />
    <UtilityPanel scopeId={scopeId} open={open} maximized={false} onToggleMaximized={() => {}} onClose={() => {}}
      fileOpenRequest={null} reviewOpenRequest={null} terminalOpenRequest={null} toolOpenRequest={null}
      imageOpenRequest={image ? { id: 1, source: { kind: "attachment", assetId: "asset", name: "image.png" } } : null}
      onOpenFile={() => {}} onOpenReview={() => {}} onOpenTerminal={() => {}} />
  </PluginUiProvider></StrictMode>))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
}
async function click(text: string) {
  const button = [...container.querySelectorAll("button")].find(item => item.textContent === text)!
  expect(button).toBeDefined(); await act(async () => button.click())
}
beforeEach(() => {
  scopeId = "session:visibility-" + ++scopeSequence
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true); vi.stubGlobal("MessageChannel", MessageChannel)
  resetWorkspaceGitProbeCacheForTests(); useDesktopSessionStore.setState(initialState, true)
  const view = emptySessionView("session")
  useDesktopSessionStore.setState({ activeSessionId: "session", selectedProject: null, selectedProjectGit: false,
    sessionView: { ...view, syncStatus: "connected", session: { ...view.session, cwd: "D:/plain", workspaceMode: "outside_project" }, parts: [{ ...sourcePart, metadata: { pluginUi: sidebar } }] } })
  const { appearance: _appearance, capabilities: _caps, ...business } = snapshot
  const state = { snapshot: { ...business, surface: "session-sidebar" }, plugin: { id: sidebar.pluginId, version: "1" }, title: sidebar.title,
    availability: { code: "available", canRender: true, canInvoke: true }, conversation: { draft: false, submit: false }, actions: [] }
  mounts = 0; unmounts = []; dismissals = 0; sidebarOpen = 0
  Object.defineProperty(window, "desktop", { configurable: true, value: {
    git: { isRepository: async () => ({ isRepository: false, rootPath: null }) },
    pluginUi: { capabilities: async () => ({ available: true }), getState: async () => state, onRevoked: () => () => {},
      mount: async () => { mounts++; return { mountId, url: "vykor-plugin-ui://frame/" + mountId, state } },
      unmount: async ({ mountId: id }) => { unmounts.push(id) }, dismiss: async () => { dismissals++ } } } })
  container = document.createElement("div"); document.body.append(container); root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount()); container.remove(); useDesktopSessionStore.setState(initialState, true)
  resetWorkspaceGitProbeCacheForTests(); vi.unstubAllGlobals(); vi.restoreAllMocks(); Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT")
})
it("keeps a panel frame and its input through another tab and panel collapse", async () => {
  await render(); expect(container.querySelector("iframe")).toBeNull(); expect(sidebarOpen).toBe(0)
  await click("在侧栏打开")
  const frame = container.querySelector("aside iframe")!, doc = (frame as HTMLIFrameElement).contentDocument!, input = doc.createElement("input")
  doc.append(input); input.value = "local form"
  await render(true, true)
  expect(container.querySelector("aside iframe")).toBe(frame); expect((frame as HTMLIFrameElement).hidden).toBe(true)
  await render(false, true); expect(container.querySelector("aside iframe")).toBe(frame); expect(unmounts).toEqual([])
  await render(true, true); await click("检查结果")
  expect(container.querySelector("aside iframe")).toBe(frame); expect((frame as HTMLIFrameElement).hidden).toBe(false)
  expect(input.value).toBe("local form"); expect(mounts).toBe(1); expect(dismissals).toBe(0)
  const close = [...container.querySelectorAll(".utility-tab-strip button[aria-label='关闭标签']")].at(-1) as HTMLButtonElement
  await act(async () => close.click())
  expect(container.querySelector("iframe")).toBeNull(); expect(unmounts).toEqual([mountId]); expect(dismissals).toBe(0)
})
it("closing other tabs also revokes a hidden plugin display without dismissing it", async () => {
  await render(); await click("在侧栏打开"); await render(true, true)
  const image = container.querySelector<HTMLButtonElement>('button[title="image.png"]')!
  await act(async () => image.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, button: 2, clientX: 50, clientY: 50 })))
  const closeOthers = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === "关闭其他标签")!
  expect(closeOthers).toBeDefined()
  await act(async () => closeOthers.click())
  expect(container.querySelector("iframe")).toBeNull(); expect(unmounts).toEqual([mountId]); expect(dismissals).toBe(0)
})
it("opening an existing hidden panel selects it without replacing its frame", async () => {
  await render(); await click("在侧栏打开")
  const frame = container.querySelector<HTMLIFrameElement>("aside iframe")!
  await render(true, true); expect(frame.hidden).toBe(true)
  await click("在侧栏打开")
  expect(container.querySelector("aside iframe")).toBe(frame); expect(frame.hidden).toBe(false)
  expect(mounts).toBe(1); expect(unmounts).toEqual([])
})

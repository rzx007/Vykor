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
import { SessionSummaryPopover } from "@renderer/components/desktop/conversation-page/session/session-summary-popover"

import { writeUtilityPanelRuntimeState, readUtilityPanelRuntimeState } from "../utility-panel-repository"
import { defaultUtilityPanelRuntimeState } from "../use-utility-panel-runtime"
import { useCodePreviewDrafts } from "@renderer/components/desktop/tools/editor/code-preview-drafts"

const destroySideChat = vi.hoisted(() => vi.fn(async (_sourceId: string) => {}))
// The real side-chat deletion identity checks are covered by side-chat-panel.test.tsx.
vi.mock("@renderer/components/desktop/tools/side-chat/side-chat-panel", async (importOriginal) => ({
  ...await importOriginal<typeof import("@renderer/components/desktop/tools/side-chat/side-chat-panel")>(),
  destroySideChat,
  SideChatPanel: () => null,
}))
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
let renderedSummary: boolean
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
async function render(sessionId = renderedSession, open = renderedOpen, summary = renderedSummary) {
  renderedSession = sessionId; renderedOpen = open
  renderedSummary = summary
  await act(async () => {
    useDesktopSessionStore.setState({ activeSessionId: sessionId, sessionView: emptySessionView(sessionId) })
    root.render(<PluginAppsProvider>
      <Panel sessionId={sessionId} open={open} />
      {summary && <SessionSummaryPopover view={emptySessionView(sessionId)} workspace={null} canOpenReview={false}
        onOpenReview={() => {}} onOpenAgents={() => {}} onOpenFile={() => {}} />}
    </PluginAppsProvider>)
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
  destroySideChat.mockReset()
  useCodePreviewDrafts.setState({ drafts: {} })
  renderedSummary = false
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

it("keeps an empty panel on its start page until the new live app is selected from the real summary", async () => {
  await render("summary-live", true, true)
  const mounted: PluginAppMount = { ...mount, mountId: "live-app", url: "about:blank", state: {
    ...mount.state, source: { sessionId: "summary-live", appId: "live" },
    app: { ...mount.state.app, id: "live", sessionId: "summary-live" },
  } }
  calls.mounts.set(mounted.mountId, mounted)
  Object.assign(calls, { openToolResult: vi.fn(async () => ({ mounted, initial: { sourcePartId: "live-part", arguments: {}, result: { content: [] } } })) })
  let page!: Awaited<ReturnType<typeof manager.openToolResult>>
  await act(async () => { page = (await manager.presentToolResult("summary-live", "live-part", true))! })
  await act(async () => { bridges.at(-1)!.oninitialized!() })
  await paint()
  const liveFrame = frame(page.id), peer = liveFrame.contentWindow!
  peer.document.body.innerHTML = '<textarea>未保存草稿</textarea>'
  expect(document.querySelector('[data-slot="popover-content"]')).not.toBeNull()
  expect(manager.panelRequest).toBeUndefined()
  assertVisible(page.id, false)
  expect(container.querySelector('[aria-label="插件应用显示区域"]')).toBeNull()
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="打开插件应用"]')!.click())
  await paint()
  assertVisible(page.id, true)
  expect(manager.panelRequest?.pageId).toBe(page.id)
  expect(frame(page.id)).toBe(liveFrame)
  expect(liveFrame.contentWindow).toBe(peer)
  expect(peer.document.querySelector("textarea")!.value).toBe("未保存草稿")
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

it("does not reveal a background app when the last ordinary tool tab closes", async () => {
  await render("last-tool", true)
  await act(async () => {
    [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.trim() === "子智能体")!.click()
  })
  let page!: Awaited<ReturnType<typeof manager.mount>>
  await act(async () => { page = await manager.mount({ sessionId: "last-tool", appId: "background" }, "后台应用") })
  await act(async () => bridges.at(-1)!.oninitialized!())
  await paint()
  const originalFrame = frame(page.id)
  originalFrame.contentWindow!.document.body.innerHTML = '<textarea>后台草稿</textarea>'
  assertVisible(page.id, false)
  const toolTab = container.querySelector<HTMLButtonElement>('button[title="子智能体"]')!
  await act(async () => toolTab.parentElement!.querySelector<HTMLButtonElement>('[aria-label="关闭标签"]')!.click())
  await paint()
  assertVisible(page.id, false)
  expect(manager.panelRequest).toBeUndefined()
  expect(container.querySelector('[aria-label="插件应用显示区域"]')).toBeNull()
  await act(async () => manager.focus(page))
  await paint()
  assertVisible(page.id, true)
  expect(frame(page.id)).toBe(originalFrame)
  expect(originalFrame.contentWindow!.document.querySelector("textarea")!.value).toBe("后台草稿")
})

async function closeFromMenu(title: string, label: string) {
  const tab = container.querySelector<HTMLButtonElement>(`button[title="${title}"]`)!
  await act(async () => tab.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 10 })))
  await act(async () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === label)!.click())
}
async function confirmAppClose() {
  await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')].find(button => button.textContent === "关闭应用")!.click())
  await paint()
}
it("confirms every requested app in visible order when closing the right tabs", async () => {
  await render("batch-apps", true)
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.trim() === "子智能体")!.click())
  const first = await openPage("batch-apps", "first"), second = await openPage("batch-apps", "second")
  await closeFromMenu("子智能体", "关闭右侧标签")
  await confirmAppClose()
  expect(manager.snapshot().map(page => page.id)).toEqual([second.id])
  expect(document.querySelector('[role="alertdialog"]')).not.toBeNull()
  await confirmAppClose()
  expect(manager.snapshot()).toEqual([])
  expect(calls.close.mock.calls).toEqual([[{ mountId: first.id, expectedRevision: 2 }], [{ mountId: second.id, expectedRevision: 2 }]])
})
it("keeps the explicitly retained app selected after closing all ordinary tabs", async () => {
  await render("keep-app", true)
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.trim() === "子智能体")!.click())
  const page = await openPage("keep-app", "retained")
  await closeFromMenu("retained", "关闭其他标签")
  await paint()
  assertVisible(page.id, true)
  expect(container.querySelector('[aria-label="插件应用显示区域"]')).not.toBeNull()
})

const mixedPreview = {
  path: "a.ts", name: "a.ts", language: "typescript", content: "original", size: 8,
  binary: false, scope: "project" as const, relativePath: "a.ts", rootLabel: "project",
  previewBytes: null, mediaType: null, imagePreviewError: null,
}
async function dialogAction(label: string) {
  await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')].find(button => button.textContent === label)!.click())
}
async function mixedRequest(id: string, extraFile = false, cleanFile = false) {
  const projectPath = "D:\\repo", scopeId = `session:${id}`
  useDesktopSessionStore.setState({ selectedProject: { id: "project", name: "project", path: projectPath, available: true, lastOpenedAt: 1 } })
  const key = JSON.stringify([scopeId, projectPath, "a.ts"])
  writeUtilityPanelRuntimeState(scopeId, {
    ...defaultUtilityPanelRuntimeState(),
    tabs: [
      { id: "kept", tool: "image", title: "保留图片", imageSource: { kind: "attachment", assetId: "kept", name: "image.png" } },
      { id: "file", tool: "files", title: "a.ts", filePath: "a.ts", projectPath },
      { id: "side-chat-tab", tool: "side-chat", title: "侧边聊天" },
    ],
    fileTabs: [{ preview: mixedPreview, type: "code", projectPath }], fileProjectPath: projectPath,
    activeFilePath: "a.ts", activeTabId: "kept",
  })
  useCodePreviewDrafts.getState().begin(key, "original", mixedPreview)
  if (!cleanFile) useCodePreviewDrafts.getState().change(key, "draft")
  const writeFile = vi.fn(async () => ({ ...mixedPreview, content: "draft" }))
  Object.assign(window.desktop, { workspace: { writeFile } })
  if (extraFile) {
    const state = readUtilityPanelRuntimeState(scopeId)!
    const preview = { ...mixedPreview, path: "b.ts", name: "b.ts", relativePath: "b.ts" }
    writeUtilityPanelRuntimeState(scopeId, { ...state,
      tabs: [...state.tabs, { id: "second-file", tool: "files", title: "b.ts", filePath: "b.ts", projectPath }],
      fileTabs: [...state.fileTabs, { preview, type: "code", projectPath }],
    })
    const secondKey = JSON.stringify([scopeId, projectPath, "b.ts"])
    useCodePreviewDrafts.getState().begin(secondKey, "original", preview)
    useCodePreviewDrafts.getState().change(secondKey, "draft b")
  }
  await render(id, true)
  const first = await openPage(id, "first"), second = await openPage(id, "second")
  await closeFromMenu("保留图片", "关闭其他标签")
  return { scopeId, key, writeFile, first, second }
}
it("keeps a mixed batch intact after a file save fails and resumes in order on retry", async () => {
  const batch = await mixedRequest("mixed-file-failure")
  batch.writeFile.mockRejectedValueOnce(new Error("磁盘写入失败"))
  await dialogAction("保存")
  expect(document.querySelector('[role="alertdialog"] [role="alert"]')?.textContent).toContain("磁盘写入失败")
  expect(readUtilityPanelRuntimeState(batch.scopeId)!.tabs.map(tab => tab.id)).toEqual(["kept", "file", "side-chat-tab"])
  expect(useCodePreviewDrafts.getState().drafts[batch.key]?.content).toBe("draft")
  expect(destroySideChat).not.toHaveBeenCalled()
  expect(calls.close).not.toHaveBeenCalled()
  await dialogAction("保存")
  expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain("关闭并销毁侧边聊天？")
  destroySideChat.mockRejectedValueOnce(new Error("侧聊销毁失败"))
  await dialogAction("关闭并销毁")
  expect(document.querySelector('[role="alertdialog"] [role="alert"]')?.textContent).toContain("侧聊销毁失败")
  expect(readUtilityPanelRuntimeState(batch.scopeId)!.tabs).toHaveLength(3)
  await dialogAction("关闭并销毁")
  expect(readUtilityPanelRuntimeState(batch.scopeId)!.tabs.map(tab => tab.id)).toEqual(["kept"])
  expect(useCodePreviewDrafts.getState().drafts[batch.key]).toBeUndefined()
  expect(calls.close).not.toHaveBeenCalled()
  await confirmAppClose()
  await confirmAppClose()
  expect(manager.snapshot()).toEqual([])
  expect(batch.writeFile).toHaveBeenCalledTimes(2)
  expect(destroySideChat).toHaveBeenNthCalledWith(1, "mixed-file-failure")
  expect(destroySideChat).toHaveBeenNthCalledWith(2, "mixed-file-failure")
})
it("retains the failed and remaining apps and retries without repeating committed work", async () => {
  const batch = await mixedRequest("mixed-app-failure")
  await dialogAction("不保存")
  await dialogAction("关闭并销毁")
  calls.close.mockRejectedValueOnce(new Error("revision conflict"))
  await confirmAppClose()
  expect(manager.snapshot().map(page => page.id)).toEqual([batch.first.id, batch.second.id])
  expect(document.querySelector('[role="alertdialog"] [role="alert"]')?.textContent).toContain("草稿已保留")
  await confirmAppClose()
  expect(manager.snapshot().map(page => page.id)).toEqual([batch.second.id])
  await confirmAppClose()
  expect(manager.snapshot()).toEqual([])
  expect(destroySideChat).toHaveBeenCalledTimes(1)
  expect(batch.writeFile).not.toHaveBeenCalled()
})
it.each(["files", "side-chat", "first-app", "second-app"])("cancels a mixed batch at %s and preserves the unprocessed work", async (phase) => {
  const batch = await mixedRequest(`mixed-cancel-${phase}`)
  if (phase !== "files") await dialogAction("不保存")
  if (phase === "first-app" || phase === "second-app") await dialogAction("关闭并销毁")
  if (phase === "second-app") await confirmAppClose()
  await dialogAction(phase.endsWith("app") ? "返回" : "取消")
  expect(document.querySelector('[role="alertdialog"]')).toBeNull()
  const committed = phase.endsWith("app")
  expect(readUtilityPanelRuntimeState(batch.scopeId)!.tabs.map(tab => tab.id)).toEqual(committed ? ["kept"] : ["kept", "file", "side-chat-tab"])
  expect(useCodePreviewDrafts.getState().drafts[batch.key]?.content).toBe(committed ? undefined : "draft")
  expect(manager.snapshot().map(page => page.id)).toEqual(phase === "second-app" ? [batch.second.id] : [batch.first.id, batch.second.id])
  expect(batch.writeFile).not.toHaveBeenCalled()
})
it.each(["files", "side-chat", "apps"])("invalidates a mixed batch across leaving and returning during %s", async (phase) => {
  const batch = await mixedRequest(`mixed-switch-${phase}`)
  let finish!: () => void
  if (phase === "files") {
    batch.writeFile.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({ ...mixedPreview, content: "draft" }) }))
    await dialogAction("保存")
  } else {
    await dialogAction("不保存")
    if (phase === "side-chat") {
      destroySideChat.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
      await dialogAction("关闭并销毁")
    } else {
      await dialogAction("关闭并销毁")
      calls.close.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
      await dialogAction("关闭应用")
    }
  }
  await render("other-session", true)
  await render(`mixed-switch-${phase}`, true)
  await act(async () => finish())
  expect(document.querySelector('[role="alertdialog"]')).toBeNull()
  expect(readUtilityPanelRuntimeState(batch.scopeId)!.tabs.map(tab => tab.id)).toEqual(phase === "apps" ? ["kept"] : ["kept", "file", "side-chat-tab"])
  expect(manager.snapshot().some(page => page.id === batch.second.id)).toBe(true)
  expect(calls.close).toHaveBeenCalledTimes(phase === "apps" ? 1 : 0)
  expect(destroySideChat).toHaveBeenCalledTimes(phase === "files" ? 0 : 1)
})
it("blocks duplicate requests and detects continued editing while saving", async () => {
  const batch = await mixedRequest("mixed-edit-save")
  let finish!: () => void
  batch.writeFile.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({ ...mixedPreview, content: "draft" }) }))
  await dialogAction("保存")
  // Dispatching again before the first write completes must not issue another write or app close.
  await dialogAction("正在保存…")
  await act(async () => container.querySelector<HTMLButtonElement>('button[title="first"]')!.parentElement!.querySelector<HTMLButtonElement>('[aria-label="关闭标签"]')!.click())
  await act(async () => useCodePreviewDrafts.getState().change(batch.key, "new edit"))
  await act(async () => finish())
  expect(document.querySelector('[role="alertdialog"] [role="alert"]')?.textContent).toContain("仍有未保存的修改")
  expect(useCodePreviewDrafts.getState().drafts[batch.key]?.content).toBe("new edit")
  expect(readUtilityPanelRuntimeState(batch.scopeId)!.tabs).toHaveLength(3)
  expect(batch.writeFile).toHaveBeenCalledTimes(1)
  expect(calls.close).not.toHaveBeenCalled()
  expect(destroySideChat).not.toHaveBeenCalled()
})

it("does not roll back a written file or commit ordinary closures if a later file fails", async () => {
  const batch = await mixedRequest("mixed-partial-save", true)
  batch.writeFile.mockResolvedValueOnce({ ...mixedPreview, content: "draft" }).mockRejectedValueOnce(new Error("b.ts 保存失败"))
  await dialogAction("保存")
  expect(document.querySelector('[role="alertdialog"] [role="alert"]')?.textContent).toContain("b.ts 保存失败")
  expect(readUtilityPanelRuntimeState(batch.scopeId)!.tabs.map(tab => tab.id)).toEqual(["kept", "file", "side-chat-tab", "second-file"])
  expect(useCodePreviewDrafts.getState().drafts[batch.key]).toMatchObject({ originalContent: "draft", content: "draft" })
  const secondKey = JSON.stringify([batch.scopeId, "D:\\repo", "b.ts"])
  expect(useCodePreviewDrafts.getState().drafts[secondKey]).toMatchObject({ originalContent: "original", content: "draft b" })
  expect(destroySideChat).not.toHaveBeenCalled()
  expect(calls.close).not.toHaveBeenCalled()
  await dialogAction("取消")
  expect(useCodePreviewDrafts.getState().drafts[batch.key]?.content).toBe("draft")
})
it("invalidates a pending file save on project changes without remounting the panel", async () => {
  const batch = await mixedRequest("mixed-project-switch")
  let finish!: () => void
  batch.writeFile.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({ ...mixedPreview, content: "draft" }) }))
  await dialogAction("保存")
  await act(async () => useDesktopSessionStore.setState({ selectedProject: { id: "other", name: "other", path: "D:/other", available: true, lastOpenedAt: 1 } }))
  await act(async () => useDesktopSessionStore.setState({ selectedProject: { id: "project", name: "project", path: "D:\\repo", available: true, lastOpenedAt: 1 } }))
  await act(async () => finish())
  expect(document.querySelector('[role="alertdialog"]')).toBeNull()
  expect(readUtilityPanelRuntimeState(batch.scopeId)!.tabs).toHaveLength(3)
  expect(readUtilityPanelRuntimeState(batch.scopeId)!.fileTabs[0]!.preview.content).toBe("original")
  expect(destroySideChat).not.toHaveBeenCalled()
  expect(calls.close).not.toHaveBeenCalled()
})
it("does not advance an app batch after the panel unmounts during an accepted close", async () => {
  const batch = await mixedRequest("mixed-unmount")
  await dialogAction("不保存")
  await dialogAction("关闭并销毁")
  let finish!: () => void
  calls.close.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  await dialogAction("关闭应用")
  await act(async () => root.render(<PluginAppsProvider><div /></PluginAppsProvider>))
  await act(async () => finish())
  expect(manager.snapshot().map(page => page.id)).toEqual([batch.second.id])
  expect(calls.close).toHaveBeenCalledTimes(1)
  expect(document.querySelector('[role="alertdialog"]')).toBeNull()
})
it("dispatches an accepted app close once and keeps the batch locked while it is pending", async () => {
  const batch = await mixedRequest("mixed-app-busy")
  await dialogAction("不保存")
  await dialogAction("关闭并销毁")
  let finish!: () => void
  calls.close.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  await dialogAction("关闭应用")
  await dialogAction("关闭应用")
  await dialogAction("返回")
  await act(async () => container.querySelector<HTMLButtonElement>('button[title="second"]')!.parentElement!.querySelector<HTMLButtonElement>('[aria-label="关闭标签"]')!.click())
  expect(calls.close).toHaveBeenCalledTimes(1)
  await act(async () => finish())
  expect(manager.snapshot().map(page => page.id)).toEqual([batch.second.id])
  await confirmAppClose()
  expect(manager.snapshot()).toEqual([])
  expect(destroySideChat).toHaveBeenCalledTimes(1)
})

it("rechecks earlier saved files after the final write before advancing a batch", async () => {
  const batch = await mixedRequest("mixed-cross-file-edit", true)
  let finishSecond!: () => void
  batch.writeFile.mockResolvedValueOnce({ ...mixedPreview, content: "draft" })
    .mockImplementationOnce(() => new Promise(resolve => {
      finishSecond = () => resolve({ ...mixedPreview, path: "b.ts", content: "draft b" })
    }))
  await dialogAction("保存")
  expect(batch.writeFile).toHaveBeenCalledTimes(2)
  expect(useCodePreviewDrafts.getState().drafts[batch.key]).toMatchObject({ originalContent: "draft", content: "draft" })
  await act(async () => useCodePreviewDrafts.getState().change(batch.key, "a2"))
  await act(async () => finishSecond())
  expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain("保存文件修改？")
  expect(document.querySelector('[role="alertdialog"] [role="alert"]')?.textContent).toContain("仍有未保存的修改")
  expect(readUtilityPanelRuntimeState(batch.scopeId)!.tabs.map(tab => tab.id)).toEqual(["kept", "file", "side-chat-tab", "second-file"])
  expect(useCodePreviewDrafts.getState().drafts[batch.key]?.content).toBe("a2")
  const secondKey = JSON.stringify([batch.scopeId, "D:\\repo", "b.ts"])
  expect(useCodePreviewDrafts.getState().drafts[secondKey]).toMatchObject({ originalContent: "draft b", content: "draft b" })
  expect(destroySideChat).not.toHaveBeenCalled()
  expect(calls.close).not.toHaveBeenCalled()
  await dialogAction("保存")
  expect(batch.writeFile).toHaveBeenCalledTimes(3)
  expect(batch.writeFile).toHaveBeenLastCalledWith({ rootPath: "D:\\repo", path: "a.ts", originalContent: "draft", content: "a2" })
  await dialogAction("关闭并销毁")
  await confirmAppClose()
  await confirmAppClose()
  expect(readUtilityPanelRuntimeState(batch.scopeId)!.tabs.map(tab => tab.id)).toEqual(["kept"])
})
it.each(["保存", "不保存", "取消"])("preserves edits made while side-chat deletion is pending and resumes with %s without deleting twice", async (choice) => {
  const batch = await mixedRequest(`mixed-side-edit-${choice}`)
  await dialogAction("保存")
  let finishDestroy!: () => void
  destroySideChat.mockImplementationOnce(() => new Promise(resolve => { finishDestroy = resolve }))
  await dialogAction("关闭并销毁")
  await act(async () => useCodePreviewDrafts.getState().change(batch.key, "after-side-confirm"))
  await act(async () => finishDestroy())
  expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain("保存文件修改？")
  expect(document.querySelector('[role="alertdialog"] [role="alert"]')?.textContent).toContain("仍有未保存的修改")
  expect(readUtilityPanelRuntimeState(batch.scopeId)!.tabs.map(tab => tab.id)).toEqual(["kept", "file", "side-chat-tab"])
  expect(useCodePreviewDrafts.getState().drafts[batch.key]).toMatchObject({ originalContent: "draft", content: "after-side-confirm" })
  expect(destroySideChat).toHaveBeenCalledTimes(1)
  expect(calls.close).not.toHaveBeenCalled()
  await dialogAction(choice)
  if (choice === "取消") {
    expect(document.querySelector('[role="alertdialog"]')).toBeNull()
    expect(readUtilityPanelRuntimeState(batch.scopeId)!.tabs).toHaveLength(3)
    expect(useCodePreviewDrafts.getState().drafts[batch.key]?.content).toBe("after-side-confirm")
    expect(manager.snapshot().map(page => page.id)).toEqual([batch.first.id, batch.second.id])
  } else {
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain("关闭插件应用？")
    expect(readUtilityPanelRuntimeState(batch.scopeId)!.tabs.map(tab => tab.id)).toEqual(["kept"])
    expect(useCodePreviewDrafts.getState().drafts[batch.key]).toBeUndefined()
    await confirmAppClose()
    await confirmAppClose()
    expect(manager.snapshot()).toEqual([])
  }
  expect(destroySideChat).toHaveBeenCalledTimes(1)
  expect(batch.writeFile).toHaveBeenCalledTimes(choice === "保存" ? 2 : 1)
})

it.each(["initially-clean", "already-saved"])("rechecks %s files edited before side-chat confirmation before dispatching deletion", async (initial) => {
  const batch = await mixedRequest(`mixed-before-side-${initial}`, false, initial === "initially-clean")
  if (initial === "already-saved") await dialogAction("保存")
  expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain("关闭并销毁侧边聊天？")
  await act(async () => useCodePreviewDrafts.getState().change(batch.key, "before-side-confirm"))
  await dialogAction("关闭并销毁")
  expect(destroySideChat).not.toHaveBeenCalled()
  expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain("保存文件修改？")
  expect(readUtilityPanelRuntimeState(batch.scopeId)!.tabs.map(tab => tab.id)).toEqual(["kept", "file", "side-chat-tab"])
  expect(useCodePreviewDrafts.getState().drafts[batch.key]?.content).toBe("before-side-confirm")
  expect(calls.close).not.toHaveBeenCalled()
  batch.writeFile.mockResolvedValueOnce({ ...mixedPreview, content: "before-side-confirm" })
  await dialogAction("保存")
  expect(batch.writeFile).toHaveBeenLastCalledWith({ rootPath: "D:\\repo", path: "a.ts", originalContent: initial === "initially-clean" ? "original" : "draft", content: "before-side-confirm" })
  expect(destroySideChat).not.toHaveBeenCalled()
  expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain("关闭并销毁侧边聊天？")
  await dialogAction("关闭并销毁")
  await confirmAppClose()
  await confirmAppClose()
  expect(readUtilityPanelRuntimeState(batch.scopeId)!.tabs.map(tab => tab.id)).toEqual(["kept"])
  expect(useCodePreviewDrafts.getState().drafts[batch.key]).toBeUndefined()
  expect(destroySideChat).toHaveBeenCalledExactlyOnceWith(`mixed-before-side-${initial}`)
})
it("rechecks an initially clean file that starts saving before side-chat confirmation", async () => {
  const batch = await mixedRequest("mixed-before-side-saving", false, true)
  await act(async () => useCodePreviewDrafts.getState().startSave(batch.key))
  await dialogAction("关闭并销毁")
  expect(destroySideChat).not.toHaveBeenCalled()
  expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain("保存文件修改？")
  expect(document.querySelector('[role="alertdialog"] [role="alert"]')?.textContent).toContain("文件正在保存")
  expect(readUtilityPanelRuntimeState(batch.scopeId)!.tabs.map(tab => tab.id)).toEqual(["kept", "file", "side-chat-tab"])
  expect(useCodePreviewDrafts.getState().drafts[batch.key]).toMatchObject({ originalContent: "original", content: "original", saving: true })
  await dialogAction("取消")
  expect(document.querySelector('[role="alertdialog"]')).toBeNull()
  expect(batch.writeFile).not.toHaveBeenCalled()
  expect(calls.close).not.toHaveBeenCalled()
  expect(manager.snapshot().map(page => page.id)).toEqual([batch.first.id, batch.second.id])
})
it.each(["保存", "不保存", "取消"])("preserves an initially clean file edited during pending side-chat deletion and resumes with %s without deleting twice", async (choice) => {
  const batch = await mixedRequest(`mixed-clean-side-edit-${choice}`, false, true)
  let finishDestroy!: () => void
  destroySideChat.mockImplementationOnce(() => new Promise(resolve => { finishDestroy = resolve }))
  await dialogAction("关闭并销毁")
  await dialogAction("正在销毁…")
  await act(async () => useCodePreviewDrafts.getState().change(batch.key, "clean-file-new-edit"))
  await act(async () => finishDestroy())
  expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain("保存文件修改？")
  expect(readUtilityPanelRuntimeState(batch.scopeId)!.tabs.map(tab => tab.id)).toEqual(["kept", "file", "side-chat-tab"])
  expect(useCodePreviewDrafts.getState().drafts[batch.key]).toMatchObject({ originalContent: "original", content: "clean-file-new-edit" })
  expect(destroySideChat).toHaveBeenCalledTimes(1)
  expect(calls.close).not.toHaveBeenCalled()
  batch.writeFile.mockResolvedValueOnce({ ...mixedPreview, content: "clean-file-new-edit" })
  await dialogAction(choice)
  if (choice === "取消") {
    expect(document.querySelector('[role="alertdialog"]')).toBeNull()
    expect(readUtilityPanelRuntimeState(batch.scopeId)!.tabs.map(tab => tab.id)).toEqual(["kept", "file", "side-chat-tab"])
    expect(useCodePreviewDrafts.getState().drafts[batch.key]?.content).toBe("clean-file-new-edit")
    expect(manager.snapshot().map(page => page.id)).toEqual([batch.first.id, batch.second.id])
    expect(calls.close).not.toHaveBeenCalled()
  } else {
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain("关闭插件应用？")
    expect(readUtilityPanelRuntimeState(batch.scopeId)!.tabs.map(tab => tab.id)).toEqual(["kept"])
    expect(useCodePreviewDrafts.getState().drafts[batch.key]).toBeUndefined()
    if (choice === "保存") expect(batch.writeFile).toHaveBeenCalledExactlyOnceWith({ rootPath: "D:\\repo", path: "a.ts", originalContent: "original", content: "clean-file-new-edit" })
    await confirmAppClose()
    await confirmAppClose()
    expect(manager.snapshot()).toEqual([])
    expect(calls.close).toHaveBeenCalledTimes(2)
  }
  expect(destroySideChat).toHaveBeenCalledTimes(1)
  expect(batch.writeFile).toHaveBeenCalledTimes(choice === "保存" ? 1 : 0)
})
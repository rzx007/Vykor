// @vitest-environment jsdom
import { act, useRef, useState } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { useDesktopSessionStore } from "@renderer/stores/desktop-session"
import {
  emptySessionView,
  resetDesktopSessionStore,
} from "@renderer/stores/desktop-session/store-test-fixtures"
import { composerDocument } from "@renderer/stores/desktop-session/composer-document"
import { selectDraftText } from "@renderer/stores/desktop-session/composer-draft-state"
import { MainLayoutContext } from "../layout/main-layout/main-layout-context"
import type { DesktopAuxSessionUpdate, DesktopSessionView } from "@shared/session-types"
import { SideChatPanel, appendSideChatQuote, sideChatTargets } from "./side-chat-panel"
import { SideChatSelectionActions } from "./side-chat-selection-actions"
import { UtilityPanel } from "../layout/main-layout/utility-panel/utility-panel"
import {
  readUtilityPanelRuntimeState,
  writeUtilityPanelRuntimeState,
} from "../layout/main-layout/utility-panel/utility-panel-repository"
import { defaultUtilityPanelRuntimeState } from "../layout/main-layout/utility-panel/use-utility-panel-runtime"
import {
  useUtilityPanelController,
  type UtilityPanelController,
} from "../layout/main-layout/utility-panel/use-utility-panel-controller"
import { getNearestEditorFromDOMNode, PASTE_COMMAND } from "lexical"
vi.hoisted(() => {
  // The native terminal's import probes Canvas; no terminal is used in these tests.
  HTMLCanvasElement.prototype.getContext = (() =>
    null) as typeof HTMLCanvasElement.prototype.getContext
})

let root: Root
let container: HTMLDivElement
let listeners: Set<(update: DesktopAuxSessionUpdate) => void>
const sideView = (source = "main", cursor = 0): DesktopSessionView => ({
  ...emptySessionView(`side-${source}`, cursor),
  session: { ...emptySessionView(`side-${source}`).session, parentId: source, storage: "memory" },
})
const fork = vi.fn(async ({ sessionId }: { sessionId: string }) => sideView(sessionId).session)
const openAux = vi.fn(async ({ sessionId }: { sessionId: string; subscriptionId: string }) =>
  sideView(sessionId.replace("side-", ""))
)
const sendPrompt = vi.fn(async (_input: unknown): Promise<void> => undefined)
const interrupt = vi.fn(async (_input: unknown) => undefined)
const replyPermission = vi.fn(async (_input: unknown) => undefined)
const closeAux = vi.fn(async (_input: unknown) => undefined)
const deleteSession = vi.fn(async (sessionId: string) => [sessionId])
const callbacks = {
  onOpenFile: () => {},
  canOpenReview: false,
  onOpenReview: () => {},
  onOpenTerminal: () => {},
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }))
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    window.setTimeout(() => callback(0), 0)
  )
  vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id))
  Range.prototype.getBoundingClientRect = () => ({
    x: 20,
    y: 40,
    top: 40,
    left: 20,
    bottom: 60,
    right: 80,
    width: 60,
    height: 20,
    toJSON() {},
  })
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList
  HTMLElement.prototype.scrollTo = () => {}
  HTMLElement.prototype.getAnimations = () => []
  localStorage.clear()
  sideChatTargets.clear()
  listeners = new Set()
  vi.clearAllMocks()
  fork.mockReset().mockImplementation(async ({ sessionId }) => sideView(sessionId).session)
  openAux.mockReset().mockImplementation(async ({ sessionId }) => sideView(sessionId.replace("side-", "")))
  sendPrompt.mockReset().mockImplementation(async () => undefined)
  replyPermission.mockReset().mockImplementation(async () => undefined)
  deleteSession.mockReset().mockImplementation(async (sessionId) => [sessionId])
  window.scrollBy = () => {}
  writeUtilityPanelRuntimeState("session:side-chat-close", {
    ...defaultUtilityPanelRuntimeState(),
    tabs: [{ id: "side-chat-tab", tool: "side-chat", title: "侧边聊天" }],
    activeTabId: "side-chat-tab",
  })
  Object.defineProperty(window, "desktop", {
    configurable: true,
    value: {
      sessions: {
        fork,
        openAux,
        closeAux,
        delete: deleteSession,
        sendPrompt,
        interrupt,
        replyPermission,
        onAuxUpdated: (callback: (update: DesktopAuxSessionUpdate) => void) => {
          listeners.add(callback)
          return () => listeners.delete(callback)
        },
        listCommands: async () => [],
        listContextPlugins: async () => [],
      },
      clipboard: { writeText: async () => {} },
      settings: { snapshot: async () => ({ showReasoning: false }), onUpdated: () => () => {} },
    },
  })
  resetDesktopSessionStore()
  const main = emptySessionView("main")
  useDesktopSessionStore.setState({
    activeSessionId: "main",
    sessionView: main,
    sessions: [main.session],
    loadStatus: "ready",
  })
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  window.getSelection()?.removeAllRanges()
  vi.unstubAllGlobals()
})
async function mount(sourceId = "main", active = true) {
  await act(async () =>
    root.render(<SideChatPanel key={sourceId} sourceId={sourceId} active={active} {...callbacks} />)
  )
}
async function mountUtilitySideChat(open = true) {
  const scopeId = "session:side-chat-close"
  if (!readUtilityPanelRuntimeState(scopeId)) {
    writeUtilityPanelRuntimeState(scopeId, {
      ...defaultUtilityPanelRuntimeState(),
      tabs: [{ id: "side-chat-tab", tool: "side-chat", title: "侧边聊天" }],
      activeTabId: "side-chat-tab",
    })
  }
  await act(async () => root.render(<UtilityPanel
    scopeId={scopeId} open={open} maximized={false} onToggleMaximized={() => {}}
    onClose={() => {}} fileOpenRequest={null} reviewOpenRequest={null}
    terminalOpenRequest={null} toolOpenRequest={null} {...callbacks}
  />))
}
async function closeSideChatTab() {
  await act(async () => container.querySelector<HTMLButtonElement>('.utility-tab-strip button[aria-label="关闭标签"]')!.click())
}
async function confirmSideChatClose() {
  await act(async () => [...document.querySelectorAll<HTMLButtonElement>("button")]
    .find((button) => button.textContent === "关闭并销毁")!.click())
}
async function submit() {
  expect(container.querySelector("form"), "ordinary shared composer must be present").not.toBeNull()
  await act(async () =>
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
  )
}
function draft(source: string, text: string) {
  useDesktopSessionStore.getState().setComposerDraftText(`linked-chat:${source}`, text)
}
function selections(scope: string): string[] {
  return (
    useDesktopSessionStore
      .getState()
      .composerDraftsByScope[scope]?.textSelections?.map((item) => item.text) ?? []
  )
}
async function emit(
  view: DesktopSessionView,
  subscriptionId = openAux.mock.calls.at(-1)![0].subscriptionId
) {
  await act(async () => listeners.forEach((listener) => listener({ subscriptionId, view })))
}

it("opening and quoting uses the side draft without creating a session or changing the main draft", async () => {
  useDesktopSessionStore.getState().setComposerDraftText("session:main", "main draft")
  draft("main", "side draft")
  appendSideChatQuote("main", "selected text")
  await mount()
  expect(container.querySelector('[contenteditable="true"]')?.textContent).toBe("side draft")
  expect(container.querySelector("form")?.textContent).toContain("1 个已选文本片段")
  expect(selections("linked-chat:main")).toEqual(["selected text"])
  expect(selectDraftText(useDesktopSessionStore.getState(), "session:main")).toBe("main draft")
  expect(fork).not.toHaveBeenCalled()
  expect(sendPrompt).not.toHaveBeenCalled()
})

it("ignores previous durable target associations stored in localStorage", async () => {
  localStorage.setItem("vykor.desktop.linked-chat-targets", JSON.stringify({ main: "legacy-fork" }))
  await mount()
  expect(openAux).not.toHaveBeenCalled()
  expect(fork).not.toHaveBeenCalled()
})

it("requires confirmation before destroying a side tab and cancellation preserves its records and draft", async () => {
  sideChatTargets.set("main", "side-main")
  useDesktopSessionStore.getState().setComposerDraftText("session:side-main", "keep draft")
  await mountUtilitySideChat()
  await closeSideChatTab()
  expect(document.querySelector('[role="alertdialog"]')).not.toBeNull()
  expect(document.body.textContent).toContain("无法恢复")
  expect(deleteSession).not.toHaveBeenCalled()
  await act(async () => document.querySelector<HTMLButtonElement>('[data-slot="alert-dialog-cancel"]')!.click())
  expect(sideChatTargets.get("main")).toBe("side-main")
  expect(selectDraftText(useDesktopSessionStore.getState(), "session:side-main")).toBe("keep draft")
  expect(container.querySelector('section[aria-label="侧边聊天"]')).not.toBeNull()
})

it("destroys only the temporary session after confirmation and removes its drafts and runtime cache", async () => {
  sideChatTargets.set("main", "side-main")
  useDesktopSessionStore.getState().setComposerDraftText("session:main", "primary draft")
  useDesktopSessionStore.getState().setComposerDraftText("session:side-main", "temporary draft")
  await mountUtilitySideChat()
  expect(useDesktopSessionStore.getState().sessionRuntimes["side-main"]).toBeDefined()
  await closeSideChatTab()
  await confirmSideChatClose()
  expect(deleteSession).toHaveBeenCalledExactlyOnceWith("side-main")
  expect(sideChatTargets.has("main")).toBe(false)
  expect(selectDraftText(useDesktopSessionStore.getState(), "session:side-main")).toBe("")
  expect(useDesktopSessionStore.getState().sessionRuntimes["side-main"]).toBeUndefined()
  expect(container.querySelector('section[aria-label="侧边聊天"]')).toBeNull()
  expect(useDesktopSessionStore.getState().activeSessionId).toBe("main")
  expect(selectDraftText(useDesktopSessionStore.getState(), "session:main")).toBe("primary draft")
})

it("discards a prefork draft on confirmed tab close without creating or deleting a session", async () => {
  draft("main", "not sent")
  appendSideChatQuote("main", "quote")
  await mountUtilitySideChat()
  await closeSideChatTab()
  await confirmSideChatClose()
  expect(fork).not.toHaveBeenCalled()
  expect(deleteSession).not.toHaveBeenCalled()
  expect(selectDraftText(useDesktopSessionStore.getState(), "linked-chat:main")).toBe("")
  expect(selections("linked-chat:main")).toEqual([])
  expect(container.querySelector('section[aria-label="侧边聊天"]')).toBeNull()
})

it("keeps the tab, target and draft when deletion fails, allowing a retry", async () => {
  sideChatTargets.set("main", "side-main")
  useDesktopSessionStore.getState().setComposerDraftText("session:side-main", "keep draft")
  deleteSession.mockRejectedValueOnce(new Error("delete offline"))
  await mountUtilitySideChat()
  await closeSideChatTab()
  await confirmSideChatClose()
  expect(document.body.textContent).toContain("delete offline")
  expect(sideChatTargets.get("main")).toBe("side-main")
  expect(selectDraftText(useDesktopSessionStore.getState(), "session:side-main")).toBe("keep draft")
  expect(container.querySelector('section[aria-label="侧边聊天"]')).not.toBeNull()
  await confirmSideChatClose()
  expect(sideChatTargets.has("main")).toBe(false)
  expect(container.querySelector('section[aria-label="侧边聊天"]')).toBeNull()
})

it("does not destroy a temporary chat when the utility panel is hidden or the component unmounts", async () => {
  sideChatTargets.set("main", "side-main")
  await mountUtilitySideChat()
  await mountUtilitySideChat(false)
  await act(async () => root.render(null))
  expect(deleteSession).not.toHaveBeenCalled()
  expect(sideChatTargets.get("main")).toBe("side-main")
})

it("waits for a pending first creation before destroying it and never sends the captured prompt", async () => {
  let finish!: (value: ReturnType<typeof sideView>["session"]) => void
  fork.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
  draft("main", "do not send")
  await mountUtilitySideChat()
  await submit()
  await closeSideChatTab()
  await confirmSideChatClose()
  expect(container.querySelector('section[aria-label="侧边聊天"]')).not.toBeNull()
  await act(async () => finish(sideView().session))
  expect(deleteSession).toHaveBeenCalledExactlyOnceWith("side-main")
  expect(sendPrompt).not.toHaveBeenCalled()
  expect(sideChatTargets.has("main")).toBe(false)
  expect(container.querySelector('section[aria-label="侧边聊天"]')).toBeNull()
})

it("does not restore or send to a destroyed target when its initial model setting finishes late", async () => {
  const original = { id: "test-model", label: "Original", provider: "Test", providerName: "test" }
  const alternate = { ...original, id: "alternate", label: "Alternate" }
  useDesktopSessionStore.setState({ models: [original, alternate] })
  let finish!: () => void
  const updateModel = vi.fn(() => new Promise<ReturnType<typeof sideView>["session"]>((resolve) => {
    finish = () => resolve({ ...sideView().session, model: "alternate" })
  }))
  Object.assign(window.desktop.sessions, { updateModel })
  draft("main", "do not send")
  await mountUtilitySideChat()
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === "Original")!.click())
  await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')].find((item) => item.textContent === "Alternate")!.click())
  await submit()
  expect(updateModel).toHaveBeenCalledTimes(1)
  await closeSideChatTab()
  await confirmSideChatClose()
  await act(async () => finish())
  expect(sendPrompt).not.toHaveBeenCalled()
  expect(useDesktopSessionStore.getState().sessions.map((session) => session.id)).toEqual(["main"])
  expect(useDesktopSessionStore.getState().sessionRuntimes["side-main"]).toBeUndefined()
  expect(sideChatTargets.has("main")).toBe(false)
})

it("allows confirmed close when the service has already lost the temporary session", async () => {
  sideChatTargets.set("main", "side-main")
  await mountUtilitySideChat()
  deleteSession.mockRejectedValueOnce(new Error("Session not found: side-main"))
  await closeSideChatTab()
  await confirmSideChatClose()
  expect(sideChatTargets.has("main")).toBe(false)
  expect(container.querySelector('section[aria-label="侧边聊天"]')).toBeNull()
})

it.each([
  { id: "main" },
  { parentId: "other-main" },
  { storage: "sqlite" as const },
])("refuses to delete a target with mismatched identity, source or storage: %s", async (patch) => {
  sideChatTargets.set("main", "side-main")
  await mountUtilitySideChat()
  openAux.mockResolvedValueOnce({ ...sideView(), session: { ...sideView().session, ...patch } })
  await closeSideChatTab()
  await confirmSideChatClose()
  expect(deleteSession).not.toHaveBeenCalled()
  expect(sideChatTargets.get("main")).toBe("side-main")
  expect(document.body.textContent).toContain("来源不匹配")
  expect(container.querySelector('section[aria-label="侧边聊天"]')).not.toBeNull()
})

it("does not close or delete the new source when switching main chats while deletion is pending", async () => {
  sideChatTargets.set("main", "side-main")
  sideChatTargets.set("other", "side-other")
  let finish!: (ids: string[]) => void
  deleteSession.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
  await mountUtilitySideChat()
  await closeSideChatTab()
  await confirmSideChatClose()
  await act(async () => useDesktopSessionStore.setState({ activeSessionId: "other", sessionView: emptySessionView("other") }))
  await act(async () => finish(["side-main"]))
  expect(deleteSession).toHaveBeenCalledExactlyOnceWith("side-main")
  expect(sideChatTargets.get("other")).toBe("side-other")
  expect(container.querySelector('section[aria-label="侧边聊天"]')).not.toBeNull()
  expect(document.querySelector('[role="alertdialog"]')).toBeNull()
})

it.each(["关闭其他标签", "关闭右侧标签"])("also confirms destruction through %s", async (action) => {
  sideChatTargets.set("main", "side-main")
  writeUtilityPanelRuntimeState("session:side-chat-close", {
    ...defaultUtilityPanelRuntimeState(),
    tabs: [
      { id: "files-tab", tool: "files", title: "文件" },
      { id: "side-chat-tab", tool: "side-chat", title: "侧边聊天" },
    ],
    activeTabId: "side-chat-tab",
  })
  await mountUtilitySideChat()
  const trigger = container.querySelector<HTMLButtonElement>('.utility-tab-strip button[title="文件"]')!
  await act(async () => trigger.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 10 })))
  await act(async () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    .find((item) => item.textContent === action)!.click())
  expect(document.querySelector('[role="alertdialog"]')).not.toBeNull()
  expect(deleteSession).not.toHaveBeenCalled()
  await confirmSideChatClose()
  expect(sideChatTargets.has("main")).toBe(false)
  expect(container.querySelector('section[aria-label="侧边聊天"]')).toBeNull()
  expect(readUtilityPanelRuntimeState("session:side-chat-close")?.tabs.map((tab) => tab.id)).toEqual(["files-tab"])
})

it("selected snippets can be previewed and removed without editing the question or sending", async () => {
  draft("main", "my question")
  appendSideChatQuote("main", "<script>literal & safe</script>\nsecond line")
  appendSideChatQuote("main", "other passage")
  await mount()
  const trigger = container.querySelector<HTMLButtonElement>('[aria-label="查看已选文本片段"]')!
  expect(trigger).not.toBeNull()
  expect(trigger.textContent).toContain("2 个已选文本片段")
  await act(async () => trigger.click())
  expect(document.body.textContent).toContain("<script>literal & safe</script>\nsecond line")
  expect(document.querySelector('[data-slot="popover-content"] script')).toBeNull()
  await act(async () =>
    document.querySelector<HTMLButtonElement>('[aria-label="移除文本片段 1"]')!.click()
  )
  expect(selections("linked-chat:main")).toEqual(["other passage"])
  expect(container.querySelector('[contenteditable="true"]')?.textContent).toBe("my question")
  expect(fork).not.toHaveBeenCalled()
  expect(sendPrompt).not.toHaveBeenCalled()
})

it("a successful send includes selected text as context and removes it from the composer", async () => {
  draft("main", "explain this")
  appendSideChatQuote("main", "original passage")
  await mount()
  await submit()
  expect(sendPrompt).toHaveBeenCalledWith(
    expect.objectContaining({
      sessionId: "side-main",
      items: [
        { type: "context", kind: "conversation", id: "main", displayName: "主聊天" },
        { type: "text", text: "选中文本片段：\n> original passage\n\n" },
        { type: "text", text: "explain this" },
      ],
    })
  )
  expect(selections("session:side-main")).toEqual([])
  expect(container.querySelector('[aria-label="查看已选文本片段"]')).toBeNull()
  expect(selectDraftText(useDesktopSessionStore.getState(), "session:main")).toBe("")
})

it("removing the last snippet closes the preview and a later quote does not reopen it or take input focus", async () => {
  draft("main", "my question")
  appendSideChatQuote("main", "first passage")
  await mount()
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="查看已选文本片段"]')!.click()
  )
  await act(async () =>
    document.querySelector<HTMLButtonElement>('[aria-label="移除文本片段 1"]')!.click()
  )
  expect(container.querySelector('[aria-label="查看已选文本片段"]')).toBeNull()
  await act(async () => appendSideChatQuote("main", "next passage"))
  expect(container.querySelector('[aria-label="查看已选文本片段"]')).not.toBeNull()
  expect(document.querySelector('[data-slot="popover-content"]')).toBeNull()
  expect(document.activeElement?.id).toBe("side-chat-composer-main")
})

it("failed sends retain selected text and retry the same ordinary input", async () => {
  sendPrompt.mockRejectedValueOnce(new Error("offline"))
  draft("main", "retry question")
  appendSideChatQuote("main", "retry passage")
  await mount()
  await submit()
  const first = sendPrompt.mock.calls[0]![0]
  expect(selections("session:side-main")).toEqual(["retry passage"])
  expect(container.querySelector('[contenteditable="true"]')?.textContent).toBe("retry question")
  await act(async () => root.render(null))
  await mount()
  expect(container.querySelector('[aria-label="查看已选文本片段"]')).not.toBeNull()
  await submit()
  expect(sendPrompt.mock.calls[1]![0]).toEqual(first)
  expect(selections("session:side-main")).toEqual([])
})

it("reopening with new source context retains previous target snippets without an invisible draft conflict", async () => {
  sideChatTargets.set("main", "side-main")
  await mount()
  await act(async () => appendSideChatQuote("main", "previous passage"))
  await act(async () => root.render(null))
  draft("main", "next question")
  appendSideChatQuote("main", "new passage")
  await mount()
  expect(container.querySelector('[role="alert"]')).toBeNull()
  expect(selections("session:side-main")).toEqual(["previous passage", "new passage"])
  expect(container.querySelector('[contenteditable="true"]')?.textContent).toBe("next question")
  await submit()
  expect(sendPrompt).toHaveBeenCalledWith(
    expect.objectContaining({
      items: [
        { type: "context", kind: "conversation", id: "main", displayName: "主聊天" },
        { type: "text", text: "选中文本片段：\n> previous passage\n\n" },
        { type: "text", text: "选中文本片段：\n> new passage\n\n" },
        { type: "text", text: "next question" },
      ],
    })
  )
  expect(selections("session:side-main")).toEqual([])
  expect(fork).not.toHaveBeenCalled()
})

it("successful acknowledgement consumes only submitted snippets even if a new identical snippet arrives", async () => {
  let finish!: () => void
  sendPrompt.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      })
  )
  draft("main", "question")
  appendSideChatQuote("main", "same passage")
  await mount()
  await submit()
  await act(async () => appendSideChatQuote("main", "same passage"))
  await act(async () => finish())
  expect(selections("session:side-main")).toEqual(["same passage"])
  expect(container.querySelector('[aria-label="查看已选文本片段"]')?.textContent).toContain(
    "1 个已选文本片段"
  )
})

it("first send forks once, sends normal context, skill, plugin and attachment items, and leaves the primary view intact", async () => {
  useDesktopSessionStore.getState().setComposerDraftDocument(
    "linked-chat:main",
    composerDocument([
      { type: "text", text: "question" },
      { type: "skill", name: "inspect", path: "/skill", displayName: "inspect" },
      { type: "capability", kind: "plugin", pluginId: "plugin-1", displayName: "Plugin" },
    ])
  )
  useDesktopSessionStore.setState({
    composerDraftsByScope: {
      ...useDesktopSessionStore.getState().composerDraftsByScope,
      "linked-chat:main": {
        ...useDesktopSessionStore.getState().composerDraftsByScope["linked-chat:main"]!,
        attachments: [
          {
            draftId: "draft-1",
            taskId: "upload-1",
            displayName: "notes.txt",
            declaredMediaType: "text/plain",
            mediaType: "text/plain",
            sizeBytes: 12,
            status: "ready",
            assetId: "asset-1",
            bytesUploaded: 12,
            progress: 1,
          },
        ],
      },
    },
  })
  const primary = useDesktopSessionStore.getState().sessionView
  await mount()
  await submit()
  expect(fork).toHaveBeenCalledExactlyOnceWith({ sessionId: "main", storage: "memory", copyHistory: false })
  expect(localStorage.getItem("vykor.desktop.linked-chat-targets")).toBeNull()
  expect(sendPrompt).toHaveBeenCalledWith(
    expect.objectContaining({
      sessionId: "side-main",
      items: [
        { type: "context", kind: "conversation", id: "main", displayName: "主聊天" },
        { type: "text", text: "question" },
        { type: "skill", name: "inspect", path: "/skill", displayName: "inspect" },
        { type: "capability", kind: "plugin", pluginId: "plugin-1", displayName: "Plugin" },
      ],
      attachments: [{ assetId: "asset-1", intent: "auto", displayName: "notes.txt" }],
    })
  )
  expect(useDesktopSessionStore.getState().activeSessionId).toBe("main")
  expect(useDesktopSessionStore.getState().sessionView).toBe(primary)
  expect(selectDraftText(useDesktopSessionStore.getState(), "session:side-main")).toBe("")
})

it("failed send preserves the draft, fork ID and ordinary stable input ID across close and retry", async () => {
  sendPrompt.mockRejectedValueOnce(new Error("offline"))
  draft("main", "retry me")
  await mount()
  await submit()
  expect(container.textContent).toContain("offline")
  expect(selectDraftText(useDesktopSessionStore.getState(), "session:side-main")).toBe("retry me")
  const first = sendPrompt.mock.calls[0]![0]
  await act(async () => root.render(null))
  await mount()
  await submit()
  expect(fork).toHaveBeenCalledTimes(1)
  expect(sendPrompt.mock.calls[1]![0]).toEqual(first)
})

it("synchronously blocks duplicate first submits while the ordinary fork is pending", async () => {
  let finish!: (value: ReturnType<typeof sideView>["session"]) => void
  fork.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  draft("main", "once")
  await mount()
  await submit()
  await submit()
  expect(fork).toHaveBeenCalledTimes(1)
  await act(async () => finish(sideView().session))
  expect(sendPrompt).toHaveBeenCalledTimes(1)
})

it("accepts only its target and subscription without cursor rollback, reconciles runtime and stops only side", async () => {
  draft("main", "hello")
  await mount()
  await submit()
  const running: DesktopSessionView = {
    ...sideView("main", 4),
    runs: [
      {
        id: "side-run",
        sessionId: "side-main",
        status: "running",
        metadata: {},
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  }
  await emit(running)
  await emit(sideView("main", 2))
  await emit(sideView("other", 99))
  await emit(sideView("main", 99), "foreign")
  expect(container.querySelector('[aria-label="停止生成"]')).not.toBeNull()
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="停止生成"]')!.click()
  )
  expect(interrupt).toHaveBeenCalledWith({ sessionId: "side-main", expectedRunId: "side-run" })
  await mount("main", false)
  expect(closeAux).toHaveBeenCalled()
  expect(interrupt).toHaveBeenCalledTimes(1)
})

it("rejects a late open snapshot after a newer event", async () => {
  let finish!: (view: DesktopSessionView) => void
  openAux.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  draft("main", "question")
  await mount()
  await submit()
  await emit({ ...sideView("main", 5), session: { ...sideView().session, status: "archived" } })
  await act(async () => finish(sideView("main", 1)))
  expect(container.textContent).toContain("归档")
  expect(container.querySelector("form")).toBeNull()
})

it("keeps A and B drafts and routes quoted text to each correct side", async () => {
  draft("main", "A")
  draft("B", "B")
  await mount()
  await submit()
  await mount("B")
  await act(async () => appendSideChatQuote("main", "quote A"))
  await act(async () => appendSideChatQuote("B", "quote B"))
  expect(container.querySelector('[contenteditable="true"]')?.textContent).toBe("B")
  expect(selections("linked-chat:B")).toEqual(["quote B"])
  expect(selections("linked-chat:main")).toEqual(["quote A"])
  await mount("main")
  expect(selections("session:side-main")).toEqual(["quote A"])
  expect(selectDraftText(useDesktopSessionStore.getState(), "linked-chat:main")).toBe("")
  expect(fork).toHaveBeenCalledTimes(1)
})

it("normal authorization cards send approval to the side session and retain reply errors", async () => {
  draft("main", "question")
  await mount()
  await submit()
  const view = {
    ...sideView("main", 1),
    permissions: [
      {
        id: "p-1",
        sessionId: "side-main",
        runId: "run-1",
        toolCallId: "call-1",
        toolName: "shell",
        reason: "run command",
        status: "pending" as const,
        payload: {},
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  }
  await emit(view)
  replyPermission.mockRejectedValueOnce(new Error("permission offline"))
  const allow = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === "允许"
  )!
  await act(async () => allow.click())
  expect(replyPermission).toHaveBeenCalledWith({
    permissionId: "p-1",
    status: "approved",
    decision: "once",
  })
  expect(
    Object.values(useDesktopSessionStore.getState().sessionRuntimes["side-main"]!.operations)
  ).toContainEqual(
    expect.objectContaining({ sessionId: "side-main", target: "p-1", phase: "failed" })
  )
  expect(container.textContent).toContain("permission offline")
})

function SelectionHarness({
  revision = 0,
  sourceId = "main",
}: {
  revision?: number
  sourceId?: string
}) {
  const viewportRef = useRef<HTMLDivElement>(null)
  return (
    <MainLayoutContext.Provider
      value={{
        conversationWorkspace: null,
        startNewConversation() {},
        openSideChat: (source, text) => appendSideChatQuote(source, text),
      }}
    >
      <div ref={viewportRef}>
        <p data-message tabIndex={0}>
          select this
        </p>
        <span>{revision}</span>
        <textarea defaultValue="exclude this" />
      </div>
      <SideChatSelectionActions sourceId={sourceId} viewportRef={viewportRef} />
    </MainLayoutContext.Provider>
  )
}
function selectText() {
  const text = container.querySelector("[data-message]")!.firstChild!
  const range = document.createRange()
  range.selectNodeContents(text)
  window.getSelection()!.removeAllRanges()
  window.getSelection()!.addRange(range)
  document.dispatchEvent(new Event("selectionchange"))
}
it("the complete drag, stream update, mouseup and click gesture leaves a clickable selection menu", async () => {
  await act(async () => root.render(<SelectionHarness />))
  const message = container.querySelector("[data-message]")!
  await act(async () => message.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })))
  await act(async () => selectText())
  await act(async () => root.render(<SelectionHarness revision={1} />))
  await act(async () => message.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })))
  await act(async () => message.dispatchEvent(new MouseEvent("click", { bubbles: true })))
  const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent === "在侧边聊天中提问"
  )!
  expect(button).toBeDefined()
  await act(async () => {
    button.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }))
    button.click()
  })
  expect(selections("linked-chat:main")).toEqual(["select this"])
  expect(fork).not.toHaveBeenCalled()
})
it("keyboard selection opens without moving focus and a second outside click or Escape closes it", async () => {
  await act(async () => root.render(<SelectionHarness />))
  container.querySelector<HTMLElement>("[data-message]")!.focus()
  const focused = document.activeElement
  await act(async () => selectText())
  const label = () =>
    [...document.querySelectorAll("button")].find((item) => item.textContent === "在侧边聊天中提问")
  expect(label()).toBeDefined()
  expect(document.activeElement).toBe(focused)
  await act(async () => document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })))
  await act(async () => document.body.dispatchEvent(new MouseEvent("click", { bubbles: true })))
  expect(label()).toBeUndefined()
  await act(async () => selectText())
  await act(async () =>
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
  )
  expect(label()).toBeUndefined()
})

it("a quotation added while fork is delayed stays in the ordinary draft and is not included in the older send", async () => {
  let finish!: (value: ReturnType<typeof sideView>["session"]) => void
  fork.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  draft("main", "old question")
  await mount()
  await submit()
  await act(async () => appendSideChatQuote("main", "new quote"))
  await act(async () => finish(sideView().session))
  expect(sendPrompt).toHaveBeenCalledWith(
    expect.objectContaining({
      items: [
        { type: "context", kind: "conversation", id: "main", displayName: "主聊天" },
        { type: "text", text: "old question" },
      ],
    })
  )
  expect(selections("session:side-main")).toEqual(["new quote"])
})

it("AskUser renders the normal answer card and records its reply only in the side runtime", async () => {
  draft("main", "question")
  await mount()
  await submit()
  await emit({
    ...sideView("main", 2),
    permissions: [
      {
        id: "ask-1",
        sessionId: "side-main",
        toolName: "AskUser",
        status: "pending",
        payload: {
          input: {
            kind: "question",
            questions: [{ question: "Which option?", options: ["Alpha", "Beta"] }],
          },
        },
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  })
  expect(container.textContent).toContain("Which option?")
  await act(async () =>
    [...container.querySelectorAll<HTMLElement>("button,[role=radio]")]
      .find((item) => item.textContent?.includes("Alpha"))!
      .click()
  )
  await act(async () =>
    [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((item) => item.textContent?.includes("提交"))!
      .click()
  )
  expect(replyPermission).toHaveBeenCalledWith({
    permissionId: "ask-1",
    status: "approved",
    decision: "once",
    answer: '{"selected":{"0":[0]},"custom":{"0":""}}',
  })
  expect(useDesktopSessionStore.getState().sessionRuntimes["main"]?.operations ?? {}).toEqual({})
})

it.each(["wrong parent", "wrong ID", "deleted"])(
  "persisted target with %s cannot send or create a replacement",
  async (kind) => {
    sideChatTargets.set("main", "side-main")
    useDesktopSessionStore.getState().setComposerDraftText("session:side-main", "do not send")
    if (kind === "deleted") openAux.mockRejectedValueOnce(new Error("session_not_found"))
    else
      openAux.mockResolvedValueOnce(
        kind === "wrong ID"
          ? sideView("other")
          : { ...sideView(), session: { ...sideView().session, parentId: "other" } }
      )
    await mount()
    await submit()
    expect(container.querySelector('[role="alert"]')).not.toBeNull()
    expect(sendPrompt).not.toHaveBeenCalled()
    expect(fork).not.toHaveBeenCalled()
  }
)

it.each([
  "Session not found: side-main",
  "Error invoking remote method 'session:aux-open': Error: Session not found: side-main",
  "Error invoking remote method 'session:aux-open': VykorApiError: Session not found: side-main",
])("recreates an expired temporary target on the next send and retains its draft: %s", async (message) => {
  sideChatTargets.set("main", "side-main")
  useDesktopSessionStore.getState().setComposerDraftText("session:side-main", "unsent question")
  useDesktopSessionStore.setState((state) => ({
    composerDraftsByScope: {
      ...state.composerDraftsByScope,
      "session:side-main": {
        ...state.composerDraftsByScope["session:side-main"]!,
        textSelections: [{ id: "quoted", text: "quoted passage" }],
        attachments: [{ draftId: "file", taskId: "upload", assetId: "asset", displayName: "note.txt",
          declaredMediaType: "text/plain", mediaType: "text/plain", sizeBytes: 2,
          status: "ready", bytesUploaded: 2, progress: 1 }],
      },
    },
  }))
  openAux.mockRejectedValueOnce(new Error(message))
  const primary = useDesktopSessionStore.getState().sessionView

  await mount()

  expect(sideChatTargets.has("main")).toBe(false)
  expect(selectDraftText(useDesktopSessionStore.getState(), "linked-chat:main")).toBe("unsent question")
  expect(selections("linked-chat:main")).toEqual(["quoted passage"])
  expect(fork).not.toHaveBeenCalled()
  expect(sendPrompt).not.toHaveBeenCalled()
  expect(useDesktopSessionStore.getState().sessionView).toBe(primary)

  await act(async () => root.render(null))
  await mount()
  expect(openAux).toHaveBeenCalledTimes(1)
  const replacement = { ...sideView(), session: { ...sideView().session, id: "side-recreated" } }
  fork.mockResolvedValueOnce(replacement.session)
  openAux.mockResolvedValueOnce(replacement)
  await submit()

  expect(fork).toHaveBeenCalledExactlyOnceWith({ sessionId: "main", storage: "memory", copyHistory: false })
  expect(sendPrompt).toHaveBeenCalledWith(expect.objectContaining({
    sessionId: "side-recreated",
    items: [
      { type: "context", kind: "conversation", id: "main", displayName: "主聊天" },
      { type: "text", text: "选中文本片段：\n> quoted passage\n\n" },
      { type: "text", text: "unsent question" },
    ],
    attachments: [{ assetId: "asset", intent: "auto", displayName: "note.txt" }],
  }))
  expect(useDesktopSessionStore.getState().sessionView).toBe(primary)
})

it.each(["Failed to fetch", "Session not found: other-target"])(
  "keeps the existing target and draft on an unconfirmed failure: %s", async (message) => {
    sideChatTargets.set("main", "side-main")
    useDesktopSessionStore.getState().setComposerDraftText("session:side-main", "keep this question")
    openAux.mockRejectedValueOnce(new Error(message))

    await mount()
    await submit()

    expect(sideChatTargets.get("main")).toBe("side-main")
    expect(selectDraftText(useDesktopSessionStore.getState(), "session:side-main")).toBe("keep this question")
    expect(fork).not.toHaveBeenCalled()
    expect(sendPrompt).not.toHaveBeenCalled()
    expect(container.querySelector('[role="alert"]')).not.toBeNull()
  }
)

it("checks a reconnecting target without replacing its live subscription and recovers only confirmed absence", async () => {
  sideChatTargets.set("main", "side-main")
  useDesktopSessionStore.getState().setComposerDraftText("session:side-main", "pending question")
  const connected = {
    ...sideView("main", 2),
    runs: [{ id: "run", sessionId: "side-main", status: "running" as const,
      metadata: {}, createdAt: 1, updatedAt: 1 }],
    messages: [{ id: "response", sessionId: "side-main", role: "assistant" as const, seq: 1,
      metadata: {}, createdAt: 1, updatedAt: 1 }],
    parts: [{ id: "text", sessionId: "side-main", messageId: "response", seq: 1, type: "text" as const,
      status: "completed" as const, text: "last response", metadata: {}, createdAt: 1, updatedAt: 1 }],
  }
  openAux.mockResolvedValueOnce(connected)
  await mount()
  const subscriptionId = openAux.mock.calls[0]![0].subscriptionId
  openAux.mockRejectedValueOnce(new Error("Failed to fetch"))

  await emit({ ...connected, syncStatus: "reconnecting" }, subscriptionId)

  expect(openAux).toHaveBeenCalledTimes(2)
  expect(openAux.mock.calls[1]![0].subscriptionId).not.toBe(subscriptionId)
  expect(closeAux).not.toHaveBeenCalledWith({ subscriptionId })
  expect(sideChatTargets.get("main")).toBe("side-main")
  expect(container.textContent).toContain("last response")
  expect(selectDraftText(useDesktopSessionStore.getState(), "session:side-main")).toBe("pending question")
  expect(fork).not.toHaveBeenCalled()

  openAux.mockRejectedValueOnce(new Error("Session not found: side-main"))
  await emit({ ...connected, syncStatus: "reconnecting" }, subscriptionId)

  expect(sideChatTargets.has("main")).toBe(false)
  expect(selectDraftText(useDesktopSessionStore.getState(), "linked-chat:main")).toBe("pending question")
  expect(container.textContent).not.toContain("last response")
  expect(fork).not.toHaveBeenCalled()
  expect(sendPrompt).not.toHaveBeenCalled()
})

it("keeps one target check in flight across repeated reconnect updates", async () => {
  sideChatTargets.set("main", "side-main")
  await mount()
  const subscriptionId = openAux.mock.calls[0]![0].subscriptionId
  let rejectCheck!: (error: Error) => void
  openAux.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectCheck = reject }))

  await emit({ ...sideView(), syncStatus: "reconnecting" }, subscriptionId)
  await emit({ ...sideView(), syncStatus: "reconnecting" }, subscriptionId)
  expect(openAux).toHaveBeenCalledTimes(2)
  expect(closeAux).not.toHaveBeenCalledWith({ subscriptionId })

  await act(async () => rejectCheck(new Error("Failed to fetch")))
  await emit({ ...sideView(), syncStatus: "reconnecting" }, subscriptionId)
  expect(openAux).toHaveBeenCalledTimes(3)
  expect(sideChatTargets.get("main")).toBe("side-main")
})

it("merges the expired target draft with a new source draft entered while its snapshot is pending", async () => {
  sideChatTargets.set("main", "side-main")
  const attachment = {
    draftId: "old-file", taskId: "old-upload", assetId: "old-asset", displayName: "old.txt",
    declaredMediaType: "text/plain", mediaType: "text/plain", sizeBytes: 2,
    status: "ready" as const, bytesUploaded: 2, progress: 1,
  }
  useDesktopSessionStore.setState({ composerDraftsByScope: {
    "session:side-main": {
      document: composerDocument([{ type: "text", text: "old question" }]),
      attachments: [attachment], textSelections: [{ id: "old-quote", text: "old quote" }],
    },
  } })
  let rejectSnapshot!: (error: Error) => void
  openAux.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectSnapshot = reject }))
  await mount()
  await act(async () => {
    draft("main", "new question")
    appendSideChatQuote("main", "new quote")
    useDesktopSessionStore.setState((state) => ({ composerDraftsByScope: {
      ...state.composerDraftsByScope,
      "linked-chat:main": { ...state.composerDraftsByScope["linked-chat:main"]!,
        attachments: [{ ...attachment, draftId: "new-file", assetId: "new-asset", displayName: "new.txt" }],
      },
    } }))
  })
  await act(async () => rejectSnapshot(new Error("Session not found: side-main")))

  expect(container.querySelector('[contenteditable="true"]')?.textContent).toContain("old question")
  expect(container.querySelector('[contenteditable="true"]')?.textContent).toContain("new question")
  expect(selectDraftText(useDesktopSessionStore.getState(), "linked-chat:main")).toBe("old question\n\nnew question")
  expect(selections("linked-chat:main")).toEqual(["old quote", "new quote"])
  expect(useDesktopSessionStore.getState().composerDraftsByScope["linked-chat:main"]?.attachments.map((item) => item.assetId))
    .toEqual(["old-asset", "new-asset"])
  expect(useDesktopSessionStore.getState().composerDraftsByScope["session:side-main"]).toBeUndefined()
  expect(sideChatTargets.has("main")).toBe(false)
  expect(fork).not.toHaveBeenCalled()
})

it("an old target check cannot close the new check after the panel is hidden and shown", async () => {
  sideChatTargets.set("main", "side-main")
  await mount()
  const subscriptionId = openAux.mock.calls[0]![0].subscriptionId
  let finishOldCheck!: (view: DesktopSessionView) => void
  openAux.mockImplementationOnce(() => new Promise((resolve) => { finishOldCheck = resolve }))
  await emit({ ...sideView(), syncStatus: "reconnecting" }, subscriptionId)
  const oldCheckId = openAux.mock.calls.at(-1)![0].subscriptionId
  await mount("main", false)
  await mount("main", true)
  let finishNewCheck!: (view: DesktopSessionView) => void
  openAux.mockImplementationOnce(() => new Promise((resolve) => { finishNewCheck = resolve }))
  await emit({ ...sideView(), syncStatus: "reconnecting" }, subscriptionId)
  const newCheckId = openAux.mock.calls.at(-1)![0].subscriptionId
  closeAux.mockClear()

  await act(async () => finishOldCheck(sideView()))
  const closedByOldCheck = closeAux.mock.calls.map(([input]) => input)
  await act(async () => finishNewCheck(sideView()))

  expect(closedByOldCheck).toContainEqual({ subscriptionId: oldCheckId })
  expect(closedByOldCheck).not.toContainEqual({ subscriptionId: newCheckId })
  expect(sideChatTargets.get("main")).toBe("side-main")
})

it("discarding an A selection on a source switch prevents appending it to B", async () => {
  await act(async () => root.render(<SelectionHarness />))
  await act(async () => selectText())
  await act(async () => root.render(<SelectionHarness sourceId="B" />))
  expect(
    [...document.querySelectorAll("button")].find((item) => item.textContent === "在侧边聊天中提问")
  ).toBeUndefined()
  expect(selectDraftText(useDesktopSessionStore.getState(), "linked-chat:B")).toBe("")
})

it("an existing utility tab yields to the selection entry and focuses the shared side composer", async () => {
  const scope = "session:selection-integration"
  writeUtilityPanelRuntimeState(scope, {
    ...defaultUtilityPanelRuntimeState(),
    tabs: [{ id: "agents-tab", tool: "agents", title: "子智能体" }],
    activeTabId: "agents-tab",
  })
  function Workspace() {
    const viewportRef = useRef<HTMLDivElement>(null)
    const [request, setRequest] = useState<{ id: number; tool: "side-chat" } | null>(null)
    return (
      <MainLayoutContext.Provider
        value={{
          conversationWorkspace: null,
          startNewConversation() {},
          openSideChat(source, text) {
            appendSideChatQuote(source, text)
            setRequest({ id: 1, tool: "side-chat" })
          },
        }}
      >
        <div ref={viewportRef}>
          <p data-message>select this</p>
        </div>
        <SideChatSelectionActions sourceId="main" viewportRef={viewportRef} />
        <UtilityPanel
          scopeId={scope}
          open
          maximized={false}
          onToggleMaximized={() => {}}
          onClose={() => {}}
          fileOpenRequest={null}
          reviewOpenRequest={null}
          terminalOpenRequest={null}
          toolOpenRequest={request}
          {...callbacks}
        />
      </MainLayoutContext.Provider>
    )
  }
  await act(async () => root.render(<Workspace />))
  await act(async () => selectText())
  await act(async () =>
    [...document.querySelectorAll<HTMLButtonElement>("button")]
      .find((item) => item.textContent === "在侧边聊天中提问")!
      .click()
  )
  for (let index = 0; index < 3; index++)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
  expect(readUtilityPanelRuntimeState(scope)?.activeTabId).toBe("side-chat-tab")
  expect(document.activeElement?.id).toBe("side-chat-composer-main")
  expect(document.activeElement?.getAttribute("contenteditable")).toBe("true")
  expect(fork).not.toHaveBeenCalled()
})

it("picker, drop and paste use ordinary prefork uploads without creating a session", async () => {
  const candidate = {
    draftId: "pick-1",
    sourceToken: "source-1",
    displayName: "picked.txt",
    declaredMediaType: "text/plain",
    sizeBytes: 2,
  }
  const startUpload = vi.fn(async () => undefined)
  const uploadClipboardImage = vi.fn(async () => undefined)
  const stageDroppedFiles = vi.fn(async () => [
    { ...candidate, draftId: "drop-1", displayName: "drop.txt" },
  ])
  Object.assign(window.desktop, {
    attachments: {
      pickFiles: async () => [candidate],
      startUpload,
      uploadClipboardImage,
      stageDroppedFiles,
    },
  })
  useDesktopSessionStore.setState({
    attachmentSupport: {
      daemonSupported: true,
      interactionEnabled: true,
      uploadModes: ["single"],
      limits: null,
    },
  })
  await mount()
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="添加上下文"]')!.click()
  )
  await act(async () =>
    [...document.querySelectorAll<HTMLElement>('button,[role="option"]')]
      .find((item) => item.textContent?.includes("文件和文件夹"))!
      .click()
  )
  expect(startUpload).toHaveBeenCalledWith(
    expect.objectContaining({ draftId: "pick-1", sourceToken: "source-1" })
  )
  const drop = new Event("drop", { bubbles: true, cancelable: true })
  Object.defineProperty(drop, "dataTransfer", {
    value: { files: [new File(["ok"], "drop.txt")], types: ["Files"] },
  })
  await act(async () => container.querySelector("form")!.dispatchEvent(drop))
  expect(stageDroppedFiles).toHaveBeenCalledTimes(1)
  const file = new File(["image"], "paste.png", { type: "image/png" })
  Object.defineProperty(file, "arrayBuffer", { value: async () => new Uint8Array([1, 2]).buffer })
  const paste = new Event("paste", { bubbles: true, cancelable: true })
  Object.defineProperty(paste, "clipboardData", {
    value: {
      files: [file],
      items: [{ kind: "file", type: "image/png", getAsFile: () => file }],
      getData: () => "",
    },
  })
  await act(async () =>
    getNearestEditorFromDOMNode(container.querySelector('[role="textbox"]')!)!.dispatchCommand(
      PASTE_COMMAND,
      paste as ClipboardEvent
    )
  )
  expect(uploadClipboardImage).toHaveBeenCalledWith(
    expect.objectContaining({ displayName: "paste.png" })
  )
  expect(
    useDesktopSessionStore.getState().composerDraftsByScope["linked-chat:main"]?.attachments
  ).toHaveLength(3)
  expect(fork).not.toHaveBeenCalled()
})

it("an ordinary click clearing selection closes an older menu", async () => {
  await act(async () => root.render(<SelectionHarness />))
  await act(async () => selectText())
  const message = container.querySelector("[data-message]")!
  await act(async () => message.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })))
  await act(async () => {
    window.getSelection()!.removeAllRanges()
    document.dispatchEvent(new Event("selectionchange"))
  })
  await act(async () => {
    message.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }))
    message.dispatchEvent(new MouseEvent("click", { bubbles: true }))
  })
  expect(
    [...document.querySelectorAll("button")].find((item) => item.textContent === "在侧边聊天中提问")
  ).toBeUndefined()
})

it("a rare target draft collision preserves both drafts, reports it and reuses the target after resolution", async () => {
  draft("main", "source draft")
  useDesktopSessionStore
    .getState()
    .setComposerDraftText("session:side-main", "existing target draft")
  await mount()
  await submit()
  expect(selectDraftText(useDesktopSessionStore.getState(), "linked-chat:main")).toBe(
    "source draft"
  )
  expect(selectDraftText(useDesktopSessionStore.getState(), "session:side-main")).toBe(
    "existing target draft"
  )
  expect(container.textContent).toContain("两份草稿")
  expect(sendPrompt).not.toHaveBeenCalled()
  await act(async () => useDesktopSessionStore.getState().resetComposerDraft("session:side-main"))
  await submit()
  expect(fork).toHaveBeenCalledTimes(1)
  expect(sendPrompt).toHaveBeenCalledWith(
    expect.objectContaining({
      sessionId: "side-main",
      items: [
        { type: "context", kind: "conversation", id: "main", displayName: "主聊天" },
        { type: "text", text: "source draft" },
      ],
    })
  )
})

it("side configuration reflects accepted session settings and rolls back a rejected permission change", async () => {
  sideChatTargets.set("main", "side-main")
  const updatePermissionMode = vi.fn().mockRejectedValueOnce(new Error("config offline"))
  Object.assign(window.desktop.sessions, { updatePermissionMode })
  await mount()
  await act(async () =>
    [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((item) => item.textContent === "手动批准")!
      .click()
  )
  await act(async () =>
    [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')]
      .find((item) => item.textContent?.includes("自动批准"))!
      .click()
  )
  expect(updatePermissionMode).toHaveBeenCalledWith({
    sessionId: "side-main",
    permissionMode: "full_auto",
  })
  expect(container.textContent).toContain("config offline")
  expect(container.textContent).toContain("手动批准")
  await emit({
    ...sideView("main", 3),
    session: { ...sideView().session, metadata: { runtime: { permissionMode: "plan" } } },
  })
  expect(
    [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (item) => item.textContent === "计划模式"
    )
  ).toBeDefined()
  expect(useDesktopSessionStore.getState().selectedPermissionMode).toBe("default")
})

it("a newer auxiliary configuration replaces a successfully changed side permission while keeping immediate RPC feedback", async () => {
  sideChatTargets.set("main", "side-main")
  const updatePermissionMode = vi.fn(async () => ({
    ...sideView().session,
    metadata: { runtime: { permissionMode: "full_auto" } },
  }))
  Object.assign(window.desktop.sessions, { updatePermissionMode })
  await mount()
  await act(async () =>
    [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((item) => item.textContent === "手动批准")!
      .click()
  )
  await act(async () =>
    [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')]
      .find((item) => item.textContent?.includes("自动批准"))!
      .click()
  )
  expect(updatePermissionMode).toHaveBeenCalledWith({
    sessionId: "side-main",
    permissionMode: "full_auto",
  })
  // The normal RPC fixture has the same timestamp as the initial auxiliary snapshot.
  expect(
    [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (item) => item.textContent === "自动批准"
    )
  ).toBeDefined()
  await emit({
    ...sideView("main", 3),
    session: {
      ...sideView().session,
      updatedAt: 2,
      metadata: { runtime: { permissionMode: "plan" } },
    },
  })
  expect(
    [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (item) => item.textContent === "计划模式"
    )
  ).toBeDefined()
  expect(useDesktopSessionStore.getState().selectedPermissionMode).toBe("default")
})

it("quotes stay in this window's visible side draft if another window changes the saved association", async () => {
  sideChatTargets.set("main", "side-main")
  await mount()
  localStorage.setItem("vykor.desktop.linked-chat-targets", JSON.stringify({ main: "other-fork" }))
  await act(async () => appendSideChatQuote("main", "visible quote"))
  expect(container.querySelector('[contenteditable="true"]')?.textContent).toBe("")
  expect(selections("session:side-main")).toEqual(["visible quote"])
  expect(selectDraftText(useDesktopSessionStore.getState(), "session:other-fork")).toBe("")
})

it("closing and reopening during the first fork reuses it without duplicating the pending question", async () => {
  let finish!: (value: ReturnType<typeof sideView>["session"]) => void
  fork.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  draft("main", "only once")
  await mount()
  await submit()
  await act(async () => root.render(null))
  await mount()
  await submit()
  await act(async () => finish(sideView().session))
  expect(fork).toHaveBeenCalledTimes(1)
  expect(sendPrompt).toHaveBeenCalledTimes(1)
  expect(useDesktopSessionStore.getState().activeSessionId).toBe("main")
})

it("a side event reconciles its pending ordinary send without changing the primary view", async () => {
  let finish!: () => void
  sendPrompt.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = () => resolve(undefined)
      })
  )
  draft("main", "event confirmed")
  const primary = useDesktopSessionStore.getState().sessionView
  await mount()
  await submit()
  const request = sendPrompt.mock.calls[0]![0] as { id: string }
  await emit({
    ...sideView("main", 2),
    inputs: [
      {
        id: request.id,
        sessionId: "side-main",
        seq: 1,
        delivery: "queue",
        items: [{ type: "text", text: "event confirmed" }],
        content: "event confirmed",
        attachments: [],
        metadata: {},
        createdAt: 1,
      },
    ],
  })
  expect(
    useDesktopSessionStore.getState().sessionRuntimes["side-main"]!.pendingPromptSubmissions[
      request.id
    ]?.phase
  ).toBe("accepted")
  expect(useDesktopSessionStore.getState().sessionView).toBe(primary)
  await act(async () => finish())
})

it("model and effort selections update the explicit side session and leave primary settings alone", async () => {
  sideChatTargets.set("main", "side-main")
  const original = {
    id: "test-model",
    label: "Original",
    provider: "Test",
    providerName: "test",
    reasoningEfforts: ["low", "high"],
  }
  const alternate = { ...original, id: "alternate", label: "Alternate" }
  useDesktopSessionStore.setState({ models: [original, alternate] })
  const updateModel = vi.fn(async () => ({
    ...sideView().session,
    model: "alternate",
    metadata: { runtime: { provider: "test" } },
  }))
  const updateEffort = vi.fn(async () => ({
    ...sideView().session,
    model: "alternate",
    metadata: { runtime: { provider: "test", effort: "high" } },
  }))
  Object.assign(window.desktop.sessions, { updateModel, updateEffort })
  await mount()
  await act(async () =>
    [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((item) => item.textContent === "Original")!
      .click()
  )
  await act(async () =>
    [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')]
      .find((item) => item.textContent === "Alternate")!
      .click()
  )
  expect(updateModel).toHaveBeenCalledWith({
    sessionId: "side-main",
    model: "alternate",
    provider: "test",
  })
  expect(container.textContent).toContain("Alternate")
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="推理强度"]')!.click()
  )
  await act(async () =>
    [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')]
      .find((item) => item.textContent === "高high")!
      .click()
  )
  expect(updateEffort).toHaveBeenCalledWith({ sessionId: "side-main", effort: "high" })
  expect(useDesktopSessionStore.getState().selectedModel).not.toBe("alternate")
  expect(useDesktopSessionStore.getState().selectedEffort).toBeNull()
})

it.each(["self", "wrong-parent"])(
  "an unverified %s association cannot receive a quote in the main or another chat draft",
  async (kind) => {
    const target = kind === "self" ? "main" : "foreign"
    sideChatTargets.set("main", target)
    const state = useDesktopSessionStore.getState()
    state.setComposerDraftText("session:main", "main remains")
    state.setComposerDraftText("session:foreign", "foreign remains")
    openAux.mockResolvedValueOnce({
      ...emptySessionView(target),
      session: {
        ...emptySessionView(target).session,
        parentId: kind === "self" ? "main" : "other",
      },
    })
    appendSideChatQuote("main", "quote before validation")
    expect(selectDraftText(useDesktopSessionStore.getState(), "session:main")).toBe("main remains")
    expect(selectDraftText(useDesktopSessionStore.getState(), "session:foreign")).toBe(
      "foreign remains"
    )
    expect(selections("linked-chat:main")).toEqual(["quote before validation"])
    await mount()
    expect(container.querySelector('[role="alert"]')).not.toBeNull()
    await act(async () => appendSideChatQuote("main", "quote after rejection"))
    expect(selectDraftText(useDesktopSessionStore.getState(), "session:main")).toBe("main remains")
    expect(selectDraftText(useDesktopSessionStore.getState(), "session:foreign")).toBe(
      "foreign remains"
    )
    expect(sendPrompt).not.toHaveBeenCalled()
  }
)

it("quotes wait in the source scope and migrate only after a saved ordinary target is verified", async () => {
  let finish!: (view: DesktopSessionView) => void
  sideChatTargets.set("main", "side-main")
  openAux.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  appendSideChatQuote("main", "waiting quote")
  await mount()
  expect(selectDraftText(useDesktopSessionStore.getState(), "session:side-main")).toBe("")
  expect(container.querySelector('[contenteditable="true"]')?.textContent).toBe("")
  expect(selections("linked-chat:main")).toEqual(["waiting quote"])
  await act(async () => finish(sideView()))
  expect(selectDraftText(useDesktopSessionStore.getState(), "linked-chat:main")).toBe("")
  expect(selections("session:side-main")).toEqual(["waiting quote"])
  await act(async () => appendSideChatQuote("main", "verified quote"))
  expect(selections("session:side-main")).toEqual(["waiting quote", "verified quote"])
  expect(fork).not.toHaveBeenCalled()
})

it("a new side request activates its retained tab after settings unmounts and remounts the controller", async () => {
  const scope = "session:main"
  writeUtilityPanelRuntimeState(scope, {
    ...defaultUtilityPanelRuntimeState(),
    tabs: [{ id: "agents-tab", tool: "agents", title: "子智能体" }],
    activeTabId: "agents-tab",
  })
  let controller!: UtilityPanelController
  const options = {
    activeSessionId: "main",
    selectedProjectId: null,
    sessionIds: ["main"],
    defaultLayout: { conversation: 50, utility: 50 },
    collapsedLayout: { conversation: 100, utility: 0 },
    conversationPanelRef: { current: null },
    utilityPanelRef: { current: null },
    workspaceGroupRef: { current: null },
    groupElementRef: { current: null },
    onCollapseSidebar() {},
  }
  function Workspace() {
    controller = useUtilityPanelController(options)
    return (
      <UtilityPanel
        scopeId={controller.scopeId}
        open={controller.open}
        maximized={controller.maximized}
        onToggleMaximized={controller.toggleMaximized}
        onClose={controller.collapse}
        fileOpenRequest={null}
        reviewOpenRequest={null}
        terminalOpenRequest={null}
        toolOpenRequest={controller.toolOpenRequest}
        {...callbacks}
      />
    )
  }
  const settle = async () => {
    for (let index = 0; index < 3; index++)
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10))
      })
  }
  await act(async () => root.render(<Workspace />))
  await act(async () => controller.openTool("side-chat"))
  await settle()
  const firstId = controller.toolOpenRequest!.id
  expect(readUtilityPanelRuntimeState(scope)?.activeTabId).toBe("side-chat-tab")
  await act(async () =>
    container.querySelector<HTMLButtonElement>('button[title="子智能体"]')!.click()
  )
  expect(readUtilityPanelRuntimeState(scope)?.activeTabId).toBe("agents-tab")
  await act(async () => root.render(<div>settings</div>))
  await act(async () => root.render(<Workspace />))
  await act(async () => controller.openTool("side-chat"))
  await settle()
  expect(controller.toolOpenRequest!.id).toBeGreaterThan(firstId)
  expect(readUtilityPanelRuntimeState(scope)?.activeTabId).toBe("side-chat-tab")
  expect(document.activeElement?.id).toBe("side-chat-composer-main")
})

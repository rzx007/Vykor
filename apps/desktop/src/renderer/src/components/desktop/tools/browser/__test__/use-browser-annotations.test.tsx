// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { useBrowserAnnotations, type BrowserAnnotationUi } from "../use-browser-annotations"
import type { BrowserAnnotationSnapshot } from "@shared/browser-annotation"
import {
  clearBrowserAnnotations,
  emptyComposerDraftState,
  putBrowserAnnotation,
  removeBrowserAnnotation,
  type ComposerDraftState,
} from "@renderer/stores/desktop-session/composer-draft-state"

const metadata: BrowserAnnotationSnapshot = { pageUrl: "http://localhost", pageRevision: 1, ready: true, mode: "off", interactionVersion: 0, eventSequence: 0, selection: null, focusedAnnotationId: null, viewport: null, annotations: [] }
const picking = { ...metadata, mode: "pick" as const, interactionVersion: 1 }
const locked: BrowserAnnotationSnapshot = { ...picking, eventSequence: 1, selection: { selectionId: "s-1", rect: { x: 10, y: 20, width: 80, height: 30 }, target: { target: "button: 提交", selector: "#target", locatorKind: "unique-id", tagName: "button", role: "button", name: "提交" } } }
let root: Root, ui: BrowserAnnotationUi, visible: boolean, read: ReturnType<typeof vi.fn>, add: ReturnType<typeof vi.fn>
let composerScope: string, drafts: ComposerDraftState
function Probe() {
  const scope = composerScope
  ui = useBrowserAnnotations({ tabId: "tab-1", visible, ready: true,
    onSaved: (record) => { drafts = putBrowserAnnotation(drafts, scope, record) },
    onRemoved: (id) => { drafts = removeBrowserAnnotation(drafts, scope, id) },
  })
  return null
}
beforeEach(async () => {
  vi.useFakeTimers(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  visible = true; read = vi.fn().mockResolvedValue(metadata); add = vi.fn().mockRejectedValue(new Error("页面已变化，请重新选择"))
  composerScope = "session:first"; drafts = emptyComposerDraftState()
  Object.defineProperty(window, "desktop", { configurable: true, value: { browser: {
    readAnnotations: read, setAnnotationMode: vi.fn().mockResolvedValue(picking), addAnnotation: add,
    focusAnnotation: vi.fn().mockResolvedValue(metadata), removeAnnotation: vi.fn().mockResolvedValue(metadata),
  } } })
  root = createRoot(document.createElement("div"))
  await act(async () => root.render(<Probe />))
})
afterEach(async () => { await act(async () => root.unmount()); vi.useRealTimers(); vi.unstubAllGlobals(); Reflect.deleteProperty(window, "desktop") })
async function choose() {
  await act(async () => { await ui.startPicking() })
  read.mockResolvedValue(locked)
  await act(async () => { await vi.advanceTimersByTimeAsync(100) })
  expect(ui.selection?.selectionId).toBe("s-1")
}
it("preserves text on a failed save and does not allow saving the expired selection", async () => {
  await choose(); act(() => ui.setDraft("调整间距"))
  await act(async () => { await ui.save() })
  expect(ui.draft).toBe("调整间距"); expect(ui.error).toContain("页面已变化")
  expect(ui.selection).toBeNull()
})
it("retains the draft and stops reading while hidden", async () => {
  await choose(); act(() => ui.setDraft("意见"))
  visible = false; await act(async () => root.render(<Probe />))
  const calls = read.mock.calls.length
  await act(async () => { await vi.advanceTimersByTimeAsync(500) })
  expect(read.mock.calls.length).toBe(calls)
  expect(ui.draft).toBe("意见"); expect(ui.selection).toBeNull()
})
it("consumes a pin click once instead of reopening a closed viewer on every read", async () => {
  await choose()
  const record = { ...locked.selection!.target, id: "a-1", pageUrl: metadata.pageUrl, comment: "意见" }
  read.mockResolvedValue({ ...picking, eventSequence: 2, focusedAnnotationId: "a-1", annotations: [{ record, status: "visible", rect: locked.selection!.rect }] })
  await act(async () => { await vi.advanceTimersByTimeAsync(100) })
  expect(ui.viewedAnnotationId).toBe("a-1")
  act(() => ui.cancelEditor())
  await act(async () => { await vi.advanceTimersByTimeAsync(300) })
  expect(ui.viewedAnnotationId).toBeNull()
})
it("does not apply a read that finishes after the panel is hidden", async () => {
  let finish!: (value: BrowserAnnotationSnapshot) => void
  read.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
  await act(async () => { await vi.advanceTimersByTimeAsync(100) })
  visible = false; await act(async () => root.render(<Probe />))
  await act(async () => { finish(locked) })
  expect(ui.selection).toBeNull(); expect(ui.pending).toBe(false)
})
it("does not discard a hidden draft when Escape closes a saved annotation viewer", async () => {
  await choose(); act(() => ui.setDraft("未保存的意见"))
  const record = { ...locked.selection!.target, id: "a-1", pageUrl: metadata.pageUrl, comment: "已有意见" }
  read.mockResolvedValue({ ...picking, eventSequence: 2, focusedAnnotationId: "a-1", annotations: [{ record, status: "visible", rect: locked.selection!.rect }] })
  await act(async () => { await vi.advanceTimersByTimeAsync(100) })
  read.mockResolvedValue({ ...picking, eventSequence: 3, focusedAnnotationId: null })
  await act(async () => { await vi.advanceTimersByTimeAsync(100) })
  expect(ui.draft).toBe("未保存的意见")
})

it("adds only the annotation just saved and does not refill a cleared composer on polling or remount", async () => {
  await choose()
  const old = { ...locked.selection!.target, id: "old", pageUrl: metadata.pageUrl, comment: "浏览器旧意见" }
  const added = { ...old, id: "new", comment: "新意见" }
  drafts = putBrowserAnnotation(drafts, composerScope, { ...old, comment: "聊天中改过的意见" })
  read.mockResolvedValue({ ...locked, annotations: [{ record: old, status: "visible", rect: null }] })
  await act(async () => { await vi.advanceTimersByTimeAsync(100) })
  const saved: BrowserAnnotationSnapshot = { ...picking, annotations: [old, added].map(record => ({ record, status: "visible", rect: null })) }
  add.mockResolvedValue(saved); act(() => ui.setDraft("新意见"))
  await act(async () => { await ui.save() })
  expect(drafts.composerDraftsByScope[composerScope]?.browserAnnotations?.map(value => value.comment))
    .toEqual(["聊天中改过的意见", "新意见"])

  drafts = clearBrowserAnnotations(drafts, composerScope)
  read.mockResolvedValue(saved)
  await act(async () => { await vi.advanceTimersByTimeAsync(300) })
  await act(async () => root.render(null))
  await act(async () => root.render(<Probe />))
  expect(drafts.composerDraftsByScope[composerScope]?.browserAnnotations).toEqual([])
})

it("keeps a completed save in its original composer when the user switches chats during the request", async () => {
  await choose(); act(() => ui.setDraft("原聊天意见"))
  const record = { ...locked.selection!.target, id: "saved", pageUrl: metadata.pageUrl, comment: "原聊天意见" }
  let finish!: (value: BrowserAnnotationSnapshot) => void
  let saving!: Promise<void>
  add.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
  await act(async () => { saving = ui.save() })
  composerScope = "session:second"; visible = false
  await act(async () => root.render(<Probe />))
  await act(async () => {
    finish({ ...picking, annotations: [{ record, status: "visible", rect: null }] })
    await saving
  })
  expect(drafts.composerDraftsByScope["session:first"]?.browserAnnotations).toEqual([record])
  expect(drafts.composerDraftsByScope["session:second"]).toBeUndefined()
})

it("removes the saved annotation from its composer after browser deletion succeeds", async () => {
  const record = { ...locked.selection!.target, id: "saved", pageUrl: metadata.pageUrl, comment: "待发送意见" }
  drafts = putBrowserAnnotation(drafts, composerScope, record)
  await act(async () => { await ui.remove(record.id) })
  expect(drafts.composerDraftsByScope[composerScope]?.browserAnnotations).toEqual([])
})

// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { useBrowserAnnotations, type BrowserAnnotationUi } from "./use-browser-annotations"
import type { BrowserAnnotationSnapshot } from "@shared/browser-annotation"

const metadata: BrowserAnnotationSnapshot = { pageUrl: "http://localhost", pageRevision: 1, ready: true, mode: "off", interactionVersion: 0, eventSequence: 0, selection: null, focusedAnnotationId: null, viewport: null, annotations: [] }
const picking = { ...metadata, mode: "pick" as const, interactionVersion: 1 }
const locked: BrowserAnnotationSnapshot = { ...picking, eventSequence: 1, selection: { selectionId: "s-1", rect: { x: 10, y: 20, width: 80, height: 30 }, target: { target: "button: 提交", selector: "#target", locatorKind: "unique-id", tagName: "button", role: "button", name: "提交" } } }
let root: Root, ui: BrowserAnnotationUi, visible: boolean, read: ReturnType<typeof vi.fn>, add: ReturnType<typeof vi.fn>
function Probe() { ui = useBrowserAnnotations({ tabId: "tab-1", visible, ready: true }); return null }
beforeEach(async () => {
  vi.useFakeTimers(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  visible = true; read = vi.fn().mockResolvedValue(metadata); add = vi.fn().mockRejectedValue(new Error("页面已变化，请重新选择"))
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

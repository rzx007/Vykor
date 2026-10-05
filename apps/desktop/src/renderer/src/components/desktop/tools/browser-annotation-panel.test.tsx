// @vitest-environment jsdom
import { act, useRef } from "react"
import { createRoot, type Root } from "react-dom/client"
import { beforeEach, afterEach, expect, it, vi } from "vitest"
import { BrowserAnnotationPanel } from "./browser-annotation-panel"
import type { BrowserAnnotationUi } from "./use-browser-annotations"
let root: Root, container: HTMLDivElement, ui: BrowserAnnotationUi, saves: number
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} })
  container = document.createElement("div"); document.body.append(container); root = createRoot(container); saves = 0
  const target = { target: "button: 提交", selector: "#target", locatorKind: "unique-id" as const, tagName: "button", role: "button", name: "提交" }
  ui = { snapshot: null, draft: "调整间距", pending: false, error: null, editing: true, listOpen: false,
    selection: { selectionId: "s-1", target, rect: { x: 10, y: 20, width: 80, height: 30 } }, viewedAnnotationId: null,
    setDraft() {}, async startPicking() {}, async showSaved() {}, async hide() {}, async save() { saves++ }, async focus() {}, async remove() {}, cancelEditor() {},
  }
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals() })
function render() { act(() => root.render(<BrowserAnnotationPanel ui={ui} containerRef={{ current: container }} />)) }
it("provides a labelled input and saves with Ctrl+Enter", () => {
  render()
  const textarea = container.querySelector("textarea")!
  expect(container.querySelector(`label[for="${textarea.id}"]`)).not.toBeNull()
  act(() => textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true })))
  expect(saves).toBe(1)
})
it("keeps the draft visible and disables save when the selection has expired", () => {
  ui.selection = null; render()
  expect(container.querySelector("textarea")!.value).toBe("调整间距")
  expect(container.textContent).toContain("重新选择")
  expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true)
})
it("makes missing targets visible in the saved annotation list", () => {
  const record = { ...ui.selection!.target, id: "a-1", pageUrl: "http://localhost", comment: "意见" }
  ui.editing = false; ui.listOpen = true
  ui.snapshot = { pageUrl: record.pageUrl, pageRevision: 1, ready: true, mode: "review", interactionVersion: 1, eventSequence: 0, selection: null, focusedAnnotationId: null, viewport: null, annotations: [{ record, status: "missing", rect: null }] }
  render()
  expect(container.textContent).toContain("目标位置暂不可用")
  expect(container.querySelector('button[aria-label="删除批注 1"]')).not.toBeNull()
})
it("uses actual parent bounds to place and contain the editor", () => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, width: 700, height: 500, top: 0, left: 0, right: 700, bottom: 500, toJSON() {} })
  ui.selection!.rect.x = 300
  ui.snapshot = { pageUrl: "http://localhost", pageRevision: 1, ready: true, mode: "pick", interactionVersion: 1, eventSequence: 1,
    selection: ui.selection, focusedAnnotationId: null, viewport: { width: 700, height: 500 }, annotations: [] }
  function Parent() {
    const ref = useRef<HTMLDivElement>(null)
    return <div ref={ref}><BrowserAnnotationPanel ui={ui} containerRef={ref} /></div>
  }
  act(() => root.render(<Parent />))
  expect(container.querySelector("form")!.style.left).toBe("300px")
  ui.selection!.rect.y = 470
  act(() => root.render(<Parent />))
  const form = container.querySelector("form")!
  expect(Number.parseFloat(form.style.top) + Number.parseFloat(form.style.maxHeight)).toBeLessThanOrEqual(500)
  vi.restoreAllMocks()
})

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { WebContents } from "electron"
import { BrowserAnnotationController, type AnnotationPageContext } from "./browser-annotation-controller"
import type { PageAnnotationCommand, PageAnnotationSnapshot } from "../../../shared/browser-annotation"

const target = { handleId: "h1", target: "button: 提交", selector: "#target", locatorKind: "unique-id" as const, tagName: "button", role: "button", name: "提交", rect: { x: 10, y: 20, width: 80, height: 30 } }
describe("BrowserAnnotationController", () => {
  let controller: BrowserAnnotationController, page: AnnotationPageContext, current: boolean
  let run: ReturnType<typeof vi.fn>, failSync: boolean
  const raw = (version: number): PageAnnotationSnapshot => ({ mode: "pick", interactionVersion: version, eventSequence: 1, selected: target, focusedAnnotationId: null, viewport: { width: 800, height: 600 }, markers: [] })
  beforeEach(() => {
    current = true; failSync = false
    run = vi.fn(async (_world: number, scripts: Array<{ code: string }>) => {
      const command = JSON.parse(scripts[0].code.slice(scripts[0].code.lastIndexOf(")(") + 2, -1)) as PageAnnotationCommand
      if (command.action === "syncMarkers" && failSync) throw new Error("page context gone")
      return raw(command.interactionVersion)
    })
    const contents = { id: 42, executeJavaScriptInIsolatedWorld: run } as unknown as WebContents
    page = { tabId: "tab-1", contents, pageUrl: "http://localhost/page", pageRevision: 1, ready: true,
      assertCurrent() { if (!current) throw new Error("页面已变化") } }
    controller = new BrowserAnnotationController()
    controller.pageReady(42, page.pageUrl, 1)
  })
  afterEach(() => vi.useRealTimers())
  async function select() {
    await controller.setMode(page, { tabId: "tab-1", pageRevision: 1, mode: "pick" })
    return (await controller.read(page)).selection!.selectionId
  }
  it("saves a selection once and exposes only saved current-page comments", async () => {
    const selectionId = await select()
    const input = { tabId: "tab-1", pageRevision: 1, selectionId, comment: " 调整间距 " }
    const saved = await controller.add(page, input)
    expect(saved.annotations).toHaveLength(1)
    expect(controller.project(42, page.pageUrl, 1)).toEqual([{ target: "button: 提交", selector: "#target", comment: "调整间距" }])
    await expect(controller.add(page, input)).rejects.toThrow()
    expect(controller.project(42, "http://localhost/other", 1)).toEqual([])
  })
  it("rejects navigation during validation without committing to the new page", async () => {
    const selectionId = await select()
    let finish!: (snapshot: PageAnnotationSnapshot) => void
    run.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    const saving = controller.add(page, { tabId: "tab-1", pageRevision: 1, selectionId, comment: "调整间距" })
    current = false; controller.navigationStarted(42, 2); finish(raw(1))
    await expect(saving).rejects.toThrow()
    controller.pageReady(42, "http://localhost/new", 2)
    expect(controller.project(42, "http://localhost/new", 2)).toEqual([])
  })
  it("keeps saved comments after suspension and same-address reload but clears another address", async () => {
    const selectionId = await select()
    await controller.add(page, { tabId: "tab-1", pageRevision: 1, selectionId, comment: "意见" })
    controller.suspend(42)
    expect(controller.project(42, page.pageUrl, 1)).toHaveLength(1)
    controller.navigationStarted(42, 2)
    expect(controller.project(42, page.pageUrl, 2)).toEqual([])
    controller.pageReady(42, page.pageUrl, 2)
    expect(controller.project(42, page.pageUrl, 2)).toHaveLength(1)
    controller.pageReady(42, "http://localhost/new", 3)
    expect(controller.project(42, "http://localhost/new", 3)).toEqual([])
  })
  it("reports committed comments even when the marker update fails", async () => {
    const selectionId = await select(); failSync = true
    const saved = await controller.add(page, { tabId: "tab-1", pageRevision: 1, selectionId, comment: "意见" })
    expect(saved.annotations[0]).toMatchObject({ status: "missing", record: { comment: "意见" } })
  })
  it("rejects empty or oversized comments without consuming a valid selection", async () => {
    const selectionId = await select()
    for (const comment of [" ", "x".repeat(2001)]) await expect(controller.add(page, { tabId: "tab-1", pageRevision: 1, selectionId, comment })).rejects.toThrow()
    expect((await controller.add(page, { tabId: "tab-1", pageRevision: 1, selectionId, comment: "有效意见" })).annotations).toHaveLength(1)
  })
  it("rejects malformed page geometry", async () => {
    await select()
    run.mockResolvedValueOnce({ ...raw(1), viewport: { width: Number.NaN, height: 600 } })
    await expect(controller.read(page)).rejects.toThrow()
  })
  it("does not let an old read timeout disable a newly opened picker", async () => {
    await select(); vi.useFakeTimers()
    run.mockReturnValueOnce(new Promise(() => {}))
    const oldRead = controller.read(page).catch(() => undefined)
    controller.suspend(42)
    await controller.setMode(page, { tabId: "tab-1", pageRevision: 1, mode: "pick" })
    await vi.advanceTimersByTimeAsync(2000); await oldRead
    expect((await controller.read(page)).mode).toBe("pick")
  })
  it("can save when a read updates the same selection during validation", async () => {
    const selectionId = await select()
    let finishRead!: (value: PageAnnotationSnapshot) => void, finishValidation!: (value: PageAnnotationSnapshot) => void
    run.mockReturnValueOnce(new Promise(resolve => { finishRead = resolve }))
    const reading = controller.read(page)
    run.mockReturnValueOnce(new Promise(resolve => { finishValidation = resolve }))
    const saving = controller.add(page, { tabId: "tab-1", pageRevision: 1, selectionId, comment: "意见" })
    finishRead(raw(1)); await reading; finishValidation(raw(1))
    expect((await saving).annotations).toHaveLength(1)
  })
  it("does not stop a new picker when a suspended install finishes late", async () => {
    let finish!: (value: PageAnnotationSnapshot) => void
    run.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    const oldInstall = controller.setMode(page, { tabId: "tab-1", pageRevision: 1, mode: "pick" }).catch(() => undefined)
    controller.suspend(42)
    await controller.setMode(page, { tabId: "tab-1", pageRevision: 1, mode: "pick" })
    finish(raw(1)); await oldInstall
    expect((await controller.read(page)).mode).toBe("pick")
  })
  it("rejects an overlapping mode change while an install is still running", async () => {
    let finish!: (value: PageAnnotationSnapshot) => void
    run.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    const installing = controller.setMode(page, { tabId: "tab-1", pageRevision: 1, mode: "pick" }).catch(() => undefined)
    const overlap = await controller.setMode(page, { tabId: "tab-1", pageRevision: 1, mode: "review" }).then(() => "allowed", error => error.message)
    finish(raw(1)); await installing
    expect(overlap).toContain("正在处理")
  })
  it("rejects an old page's stop request instead of closing the new picker", async () => {
    await select(); controller.navigationStarted(42, 2); controller.pageReady(42, page.pageUrl, 2)
    const next = { ...page, pageRevision: 2 }
    await controller.setMode(next, { tabId: "tab-1", pageRevision: 2, mode: "pick" })
    await expect(controller.setMode(next, { tabId: "tab-1", pageRevision: 1, mode: "off" })).rejects.toThrow()
    expect((await controller.read(next)).mode).toBe("pick")
  })
})

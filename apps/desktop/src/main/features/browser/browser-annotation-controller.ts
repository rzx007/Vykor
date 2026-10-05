import type { WebContents } from "electron"
import type {
  AddAnnotationInput,
  AnnotationIdInput,
  AnnotationRect,
  AnnotationTarget,
  BrowserAnnotationRecord,
  BrowserAnnotationSnapshot,
  PageAnnotationCommand,
  PageAnnotationSnapshot,
  SetAnnotationModeInput,
} from "../../../shared/browser-annotation"
import { BROWSER_ANNOTATION_WORLD_ID, buildAnnotationScript } from "./browser-annotation-script"

export type AnnotationPageContext = {
  tabId: string
  contents: WebContents
  pageUrl: string
  pageRevision: number
  ready: boolean
  assertCurrent: () => void
}
type Selection = {
  selectionId: string
  handleId: string
  target: AnnotationTarget
  rect: AnnotationRect
}
type PageState = {
  contents: WebContents | null
  pageUrl: string
  pageRevision: number
  ready: boolean
  mode: "off" | "pick" | "review"
  version: number
  selection: Selection | null
  records: BrowserAnnotationRecord[]
  handles: Map<string, string>
  raw: PageAnnotationSnapshot | null
  consumedHandle: string | null
  busy: number | null
}
const invalid = (): never => {
  throw new Error("无法读取页面批注，请重新开启")
}
const text = (value: unknown, max: number, required = false): string => {
  if (typeof value !== "string" || value.length > max || (required && !value)) return invalid()
  return value
}
function geometry(value: unknown): AnnotationRect {
  if (!value || typeof value !== "object") return invalid()
  const r = value as AnnotationRect
  if (
    ![r.x, r.y, r.width, r.height].every(
      (n) => typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= 1_000_000
    ) ||
    r.width <= 0 ||
    r.height <= 0
  )
    return invalid()
  return { x: r.x, y: r.y, width: r.width, height: r.height }
}
function target(value: AnnotationTarget): AnnotationTarget {
  if (!value || typeof value !== "object") return invalid()
  if (!["unique-id", "semantic", "path"].includes(value.locatorKind)) return invalid()
  return {
    target: text(value.target, 200, true),
    selector: text(value.selector, 512, true),
    locatorKind: value.locatorKind,
    tagName: text(value.tagName, 80, true),
    role: text(value.role, 80, true),
    name: text(value.name, 180),
  }
}
function decode(value: unknown): PageAnnotationSnapshot {
  if (!value || typeof value !== "object") return invalid()
  const v = value as PageAnnotationSnapshot
  if (
    !["off", "pick", "review"].includes(v.mode) ||
    !Number.isSafeInteger(v.interactionVersion) ||
    v.interactionVersion < 0 ||
    !Number.isSafeInteger(v.eventSequence) ||
    v.eventSequence < 0
  )
    return invalid()
  if (
    !v.viewport ||
    ![v.viewport.width, v.viewport.height].every(
      (n) => Number.isFinite(n) && n > 0 && n <= 1_000_000
    )
  )
    return invalid()
  if (!Array.isArray(v.markers) || v.markers.length > 20) return invalid()
  const markers = v.markers.map((m) => {
    if (!m || !["visible", "offscreen", "missing"].includes(m.status)) return invalid()
    return {
      id: text(m.id, 128, true),
      status: m.status,
      rect: m.rect === null ? null : geometry(m.rect),
    }
  })
  const selected =
    v.selected === null
      ? null
      : {
          ...target(v.selected),
          handleId: text(v.selected.handleId, 128, true),
          rect: geometry(v.selected.rect),
        }
  return {
    mode: v.mode,
    interactionVersion: v.interactionVersion,
    eventSequence: v.eventSequence,
    selected,
    focusedAnnotationId:
      v.focusedAnnotationId === null ? null : text(v.focusedAnnotationId, 128, true),
    viewport: { width: v.viewport.width, height: v.viewport.height },
    markers,
  }
}

export class BrowserAnnotationController {
  private readonly pages = new Map<number, PageState>()
  private sequence = 0

  pageReady(id: number, url: string, revision: number): void {
    const state = this.pages.get(id)
    if (!state) {
      this.pages.set(id, {
        contents: null,
        pageUrl: url,
        pageRevision: revision,
        ready: true,
        mode: "off",
        version: 0,
        selection: null,
        records: [],
        handles: new Map(),
        raw: null,
        consumedHandle: null,
        busy: null,
      })
      return
    }
    if (state.pageUrl !== url) {
      state.records = []
      state.handles.clear()
    }
    if (state.pageRevision !== revision) {
      state.selection = null
      state.raw = null
    }
    state.pageUrl = url
    state.pageRevision = revision
    state.ready = true
  }

  navigationStarted(id: number, revision: number): void {
    this.suspend(id)
    const state = this.pages.get(id)
    if (state) {
      state.ready = false
      state.pageRevision = revision
      state.handles.clear()
    }
  }

  suspend(id: number): void {
    const state = this.pages.get(id)
    if (!state) return
    state.version++
    state.busy = null
    state.mode = "off"
    state.selection = null
    state.raw = null
    state.consumedHandle = null
    if (state.contents) {
      try {
        void state.contents
          .executeJavaScriptInIsolatedWorld(BROWSER_ANNOTATION_WORLD_ID, [
            { code: buildAnnotationScript({ action: "stop", interactionVersion: state.version }) },
          ])
          .catch(() => undefined)
      } catch {
        /* A guest can disappear during detach. */
      }
    }
  }

  release(id: number): void {
    this.suspend(id)
    this.pages.delete(id)
  }

  async pauseForBrowserAction(contents: WebContents): Promise<void> {
    const state = this.pages.get(contents.id)
    if (!state || state.mode !== "pick") return
    this.suspend(contents.id)
    const version = state.version
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      // Lifecycle cleanup is immediate in Main; await page cleanup before dispatching a DOM action.
      const raw = decode(
        await Promise.race([
          contents.executeJavaScriptInIsolatedWorld(BROWSER_ANNOTATION_WORLD_ID, [
            { code: buildAnnotationScript({ action: "stop", interactionVersion: version }) },
          ]),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error("未能结束批注选择，请重试浏览器操作")), 2000)
          }),
        ])
      )
      if (raw.mode !== "off" || raw.interactionVersion !== version || state.version !== version) {
        throw new Error("页面选择状态已变化，请重试浏览器操作")
      }
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  project(
    id: number,
    url: string,
    revision: number
  ): Array<{ target: string; comment: string; selector: string }> {
    const state = this.pages.get(id)
    return state?.ready && state.pageUrl === url && state.pageRevision === revision
      ? state.records.map(({ target, comment, selector }) => ({ target, comment, selector }))
      : []
  }

  private state(page: AnnotationPageContext): PageState {
    page.assertCurrent()
    if (!this.pages.has(page.contents.id))
      this.pageReady(page.contents.id, page.pageUrl, page.pageRevision)
    const state = this.pages.get(page.contents.id)!
    if (state.pageRevision !== page.pageRevision || state.pageUrl !== page.pageUrl)
      throw new Error("页面已变化，请重新选择目标")
    state.contents = page.contents
    return state
  }

  private snapshot(state: PageState): BrowserAnnotationSnapshot {
    const raw = state.raw
    return {
      pageUrl: state.pageUrl,
      pageRevision: state.pageRevision,
      ready: state.ready,
      mode: state.mode,
      interactionVersion: state.version,
      eventSequence: raw?.eventSequence ?? 0,
      selection: state.selection
        ? {
            selectionId: state.selection.selectionId,
            target: { ...state.selection.target },
            rect: { ...state.selection.rect },
          }
        : null,
      focusedAnnotationId:
        raw?.focusedAnnotationId && state.records.some((r) => r.id === raw.focusedAnnotationId)
          ? raw.focusedAnnotationId
          : null,
      viewport: raw?.viewport ?? null,
      annotations: state.records.map((record) => {
        const marker = raw?.markers.find((m) => m.id === record.id)
        return {
          record: { ...record },
          status: marker?.status ?? "missing",
          rect: marker?.rect ?? null,
        }
      }),
    }
  }

  private async call(
    page: AnnotationPageContext,
    state: PageState,
    command: PageAnnotationCommand
  ): Promise<PageAnnotationSnapshot> {
    page.assertCurrent()
    const version = state.version
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const value = await Promise.race([
        page.contents.executeJavaScriptInIsolatedWorld(BROWSER_ANNOTATION_WORLD_ID, [
          { code: buildAnnotationScript(command) },
        ]),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            if (this.pages.get(page.contents.id) === state && state.version === version) {
              this.suspend(page.contents.id)
            }
            reject(new Error("页面批注响应超时，请重新开启"))
          }, 2000)
        }),
      ])
      page.assertCurrent()
      if (
        this.pages.get(page.contents.id) !== state ||
        state.version !== version ||
        state.pageRevision !== page.pageRevision
      )
        throw new Error("选择已失效，请重新选择目标")
      const raw = decode(value)
      if (raw.interactionVersion !== version) throw new Error("选择已失效，请重新选择目标")
      return raw
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private apply(state: PageState, raw: PageAnnotationSnapshot, select = true): void {
    if (state.raw && raw.eventSequence < state.raw.eventSequence) return
    state.raw = raw
    state.mode = raw.mode
    if (!select || !raw.selected || raw.selected.handleId === state.consumedHandle) {
      state.selection = null
      return
    }
    const item = raw.selected
    state.selection = {
      selectionId:
        state.selection?.handleId === item.handleId
          ? state.selection.selectionId
          : `s-${++this.sequence}`,
      handleId: item.handleId,
      target: target(item),
      rect: item.rect,
    }
  }

  private checkInput(
    state: PageState,
    page: AnnotationPageContext,
    input: { tabId: string; pageRevision: number }
  ): void {
    if (
      input.tabId !== page.tabId ||
      input.pageRevision !== state.pageRevision ||
      !state.ready ||
      !page.ready
    )
      throw new Error("页面已变化，请重新选择目标")
  }

  private async sync(page: AnnotationPageContext, state: PageState): Promise<void> {
    const markers = state.records.map((record) => ({
      ...target(record),
      id: record.id,
      handleId: state.handles.get(record.id) ?? null,
    }))
    this.apply(
      state,
      await this.call(page, state, {
        action: "syncMarkers",
        interactionVersion: state.version,
        markers,
      }),
      false
    )
  }

  async read(page: AnnotationPageContext): Promise<BrowserAnnotationSnapshot> {
    const state = this.state(page)
    if (state.ready && state.mode !== "off" && !state.busy)
      this.apply(
        state,
        await this.call(page, state, { action: "read", interactionVersion: state.version })
      )
    return this.snapshot(state)
  }

  async setMode(
    page: AnnotationPageContext,
    input: SetAnnotationModeInput
  ): Promise<BrowserAnnotationSnapshot> {
    const state = this.state(page)
    if (input.tabId !== page.tabId || input.pageRevision !== state.pageRevision) {
      throw new Error("页面已变化，请重新选择目标")
    }
    if (input.mode === "off") {
      this.suspend(page.contents.id)
      return this.snapshot(state)
    }
    this.checkInput(state, page, input)
    if (state.busy) throw new Error("正在处理批注，请稍后重试")
    const write = ++this.sequence
    state.busy = write
    state.version++
    const version = state.version
    state.selection = null
    state.raw = null
    state.consumedHandle = null
    try {
      this.apply(
        state,
        await this.call(page, state, {
          action: "install",
          mode: input.mode,
          interactionVersion: state.version,
        })
      )
      await this.sync(page, state)
      return this.snapshot(state)
    } catch (error) {
      if (state.version === version) this.suspend(page.contents.id)
      throw error
    } finally {
      if (state.busy === write) state.busy = null
    }
  }

  async add(
    page: AnnotationPageContext,
    input: AddAnnotationInput
  ): Promise<BrowserAnnotationSnapshot> {
    const state = this.state(page)
    this.checkInput(state, page, input)
    const comment = typeof input.comment === "string" ? input.comment.trim() : ""
    if (!comment || comment.length > 2000) throw new Error("请填写 1–2000 字的批注意见")
    if (state.records.length >= 20) throw new Error("本页最多保存 20 条批注，请先删除一条")
    if (state.busy) throw new Error("正在处理批注，请稍后重试")
    const selection = state.selection
    if (!selection || selection.selectionId !== input.selectionId)
      throw new Error("选择已失效，请重新选择目标")
    const write = ++this.sequence
    state.busy = write
    try {
      const checked = await this.call(page, state, {
        action: "validateSelection",
        interactionVersion: state.version,
        handleId: selection.handleId,
      })
      if (
        checked.selected?.handleId !== selection.handleId ||
        state.selection?.selectionId !== selection.selectionId
      )
        throw new Error("目标已变化，请重新选择；草稿已保留")
      page.assertCurrent()
      const record: BrowserAnnotationRecord = {
        ...selection.target,
        id: `a-${++this.sequence}`,
        pageUrl: state.pageUrl,
        comment,
      }
      state.records.push(record)
      state.handles.set(record.id, selection.handleId)
      state.consumedHandle = selection.handleId
      state.selection = null
      try {
        await this.sync(page, state)
      } catch {
        state.raw = null
      }
      return this.snapshot(state)
    } finally {
      if (state.busy === write) state.busy = null
    }
  }

  async focus(
    page: AnnotationPageContext,
    input: AnnotationIdInput
  ): Promise<BrowserAnnotationSnapshot> {
    const state = this.state(page)
    this.checkInput(state, page, input)
    if (!state.records.some((r) => r.id === input.annotationId)) throw new Error("批注已不存在")
    if (state.busy) throw new Error("正在处理批注，请稍后重试")
    if (state.mode === "off") await this.setMode(page, { ...input, mode: "review" })
    if (state.busy) throw new Error("正在处理批注，请稍后重试")
    const write = ++this.sequence
    state.busy = write
    try {
      this.apply(
        state,
        await this.call(page, state, {
          action: "focusAnnotation",
          interactionVersion: state.version,
          annotationId: input.annotationId,
        })
      )
      return this.snapshot(state)
    } finally {
      if (state.busy === write) state.busy = null
    }
  }

  async remove(
    page: AnnotationPageContext,
    input: AnnotationIdInput
  ): Promise<BrowserAnnotationSnapshot> {
    const state = this.state(page)
    this.checkInput(state, page, input)
    if (state.busy) throw new Error("正在处理批注，请稍后重试")
    if (!state.records.some((r) => r.id === input.annotationId)) throw new Error("批注已不存在")
    const write = ++this.sequence
    state.busy = write
    try {
      state.records = state.records.filter((r) => r.id !== input.annotationId)
      state.handles.delete(input.annotationId)
      if (state.mode !== "off") {
        try {
          await this.sync(page, state)
        } catch {
          state.raw = null
        }
      }
      return this.snapshot(state)
    } finally {
      if (state.busy === write) state.busy = null
    }
  }
}

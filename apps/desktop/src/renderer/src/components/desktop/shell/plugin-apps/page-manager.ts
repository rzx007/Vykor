import type { DesktopPluginAppsAPI, PluginAppMount } from "@shared/plugin-app-types"
import { PluginAppController, type AppConfirmation } from "./controller"
import type { PluginAppTransport } from "./transport"
export type AppDisplayMode = "inline" | "fullscreen"
type InitialResult = { sourcePartId: string; arguments: Record<string, unknown>; result: unknown }
type Placement = { rect: DOMRect | null; mode: AppDisplayMode }
export interface ResidentAppPage {
  id: string; title: string; controller: PluginAppController; transport?: PluginAppTransport; element?: HTMLDivElement
  initial?: { arguments: Record<string, unknown>; result?: unknown }
  /** Pending bodies transfer to the transport; only Part IDs survive delivery. */
  results?: Map<string, InitialResult>; sourceParts?: Set<string>
  modes?: AppDisplayMode[]; initializationError?: string; menuRejection?: string; expanded?: boolean
  onModes?(modes: AppDisplayMode[]): void; onInitializationError?(error: unknown): void
  requestDisplayMode?(mode: AppDisplayMode): void
}
export function canUseAppSidebar(page: ResidentAppPage): boolean { return !!page.modes?.length }
export function appPanelMode(page: ResidentAppPage): AppDisplayMode { return page.modes?.includes("inline") ? "inline" : "fullscreen" }
export interface AppPanelRequest { sequence: number; pageId: string; sessionId: string }
/** Pages live under the root owner. Layout anchors only set CSS; they never move iframe nodes. */
export class PluginAppPageManager {
  private pages: ResidentAppPage[] = []
  private readonly removing = new Map<string, Promise<void>>()
  private readonly listeners = new Set<() => void>()
  private readonly anchors = new Map<string, Map<symbol, Placement>>()
  private readonly liveResults = new Set<string>()
  private readonly openingResults = new Map<string, Promise<ResidentAppPage>>()
  private sequence = 0
  private activeSessionId?: string | null
  panelRequest?: AppPanelRequest
  constructor(readonly api: DesktopPluginAppsAPI, private readonly confirm: AppConfirmation) {}
  snapshot = () => this.pages
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private emit(): void { this.pages = [...this.pages]; this.listeners.forEach(listener => listener()) }
  setActiveSession(sessionId: string | null): void { this.activeSessionId = sessionId }
  focus(page: ResidentAppPage): void {
    if (!this.pages.includes(page)) return
    if (this.activeSessionId !== undefined && this.activeSessionId !== page.controller.state.source.sessionId) return
    this.panelRequest = { sequence: ++this.sequence, pageId: page.id, sessionId: page.controller.state.source.sessionId }
    this.emit()
  }
  async resultTitle(sessionId: string, origin: unknown): Promise<string> {
    if (!origin || typeof origin !== "object") return "插件应用"
    const source = origin as { pluginId?: string; backendId?: string; resourceUri?: string }
    try {
      const catalog = await this.api.catalog({ sessionId })
      const backend = catalog.backends.find(item => item.pluginId === source.pluginId && item.backendId === source.backendId)
      const surfaces = backend?.surfaces.filter(surface => surface.resourceUri === source.resourceUri)
      return surfaces?.length === 1 ? surfaces[0]!.title : "插件应用"
    } catch { return "插件应用" }
  }
  private add(mount: PluginAppMount, title: string): ResidentAppPage {
    const prior = this.pages.find(page => page.id === mount.mountId)
    if (prior) return prior
    const page: ResidentAppPage = { id: mount.mountId, title, controller: new PluginAppController(mount, this.api, (request, signal) => this.confirm(request, signal, {
      title: page.title, pluginId: mount.state.app.pluginId, sessionId: mount.state.source.sessionId,
      description: "toolName" in request ? page.controller.state.tools?.find(tool => tool.name === request.toolName)?.description : undefined,
    })),
      onModes: modes => { page.modes = modes; this.applyPlacement(page); this.emit() },
      onInitializationError: error => { page.initializationError = String(error); this.emit() },
      requestDisplayMode: mode => this.requestDisplayMode(page, mode) }
    page.controller.setVisible(false)
    this.pages.push(page); this.emit(); return page
  }
  private waitForModes(page: ResidentAppPage): Promise<void> {
    return new Promise((resolve, reject) => {
      const finish = (error?: Error) => { clearTimeout(timer); off(); error ? reject(error) : resolve() }
      const check = () => {
        if (!this.pages.includes(page) || page.initializationError) finish(new Error("应用页面初始化失败，请检查插件状态。"))
        else if (page.modes) finish()
      }
      const timer = setTimeout(() => finish(new Error("应用页面初始化超时，请重试。")), 10_000)
      const off = this.subscribe(check)
      check()
    })
  }
  async open(sessionId: string, pluginId: string, surfaceId: string, title: string): Promise<ResidentAppPage> {
    const existing = this.pages.find(page => page.controller.state.source.sessionId === sessionId && page.controller.state.app.pluginId === pluginId
      && page.controller.state.app.origin.kind === "surface" && page.controller.state.app.origin.surfaceId === surfaceId)
    if (!existing) {
      const owned = this.pages.filter(page => page.controller.state.source.sessionId === sessionId)
      if (this.pages.length >= 8 || owned.length >= 4) throw new Error("已达到页面上限。请先关闭不再需要的页面；现有草稿已保留。")
    }
    const page = existing ?? this.add(await this.api.open({ sessionId, pluginId, surfaceId }), title)
    try {
      await this.waitForModes(page)
      if (!canUseAppSidebar(page)) throw new Error("此应用没有可用的显示模式。")
      return page
    } catch (error) {
      if (!existing && !page.sourceParts?.size) {
        const cleanup = await this.api.rejectMenuOpen({ mountId: page.id }).catch(() => ({ closed: false }))
        if (cleanup.closed) await this.remove(page.id)
        else { page.menuRejection = "此应用未进入侧栏；未能确认是否仍被使用，未自动关闭。"; this.emit() }
      }
      throw error
    }
  }
  async mount(source: { sessionId: string; appId: string }, title: string): Promise<ResidentAppPage> { return this.add(await this.api.mount(source), title) }
  async openToolResult(sessionId: string, sourcePartId: string, focusOnlyIfMounted = false): Promise<ResidentAppPage> {
    const key = `${sessionId}:${sourcePartId}:${focusOnlyIfMounted}`
    const opening = this.openingResults.get(key)
    if (opening) return opening
    const work = this.loadToolResult(sessionId, sourcePartId, focusOnlyIfMounted)
    this.openingResults.set(key, work)
    try { return await work } finally { this.openingResults.delete(key) }
  }
  private async loadToolResult(sessionId: string, sourcePartId: string, focusOnlyIfMounted: boolean): Promise<ResidentAppPage> {
    if (!this.api.openToolResult) throw new Error("工具结果入口不可用")
    const { mounted, initial } = await this.api.openToolResult({ sessionId, sourcePartId })
    const existing = this.pages.find(page => page.id === mounted.mountId)
    const page = existing ?? this.add(mounted, "插件应用")
    // 名称查询不能阻塞结果投递，否则目录响应反序会把新结果倒退为旧结果。
    void this.resultTitle(sessionId, mounted.state.app).then(title => {
      if (title !== "插件应用" && this.pages.includes(page) && page.title !== title) { page.title = title; this.emit() }
    })
    page.sourceParts ??= new Set()
    if ((!focusOnlyIfMounted || !existing) && !page.sourceParts.has(initial.sourcePartId)) {
      page.sourceParts.add(initial.sourcePartId)
      if (page.transport) page.transport.queueToolResult(initial)
      else { page.results ??= new Map(); page.results.set(initial.sourcePartId, initial) }
    }
    this.emit()
    return page
  }
  async presentToolResult(sessionId: string, sourcePartId: string, live = false): Promise<ResidentAppPage | undefined> {
    const key = `${sessionId}:${sourcePartId}`
    if (live && this.liveResults.has(key)) return
    if (live) this.liveResults.add(key)
    const page = await this.openToolResult(sessionId, sourcePartId, !live)
    // 实时结果交给工作摘要提示；只有用户明确打开时才定位右侧面板。
    if (!live) this.focus(page)
    return page
  }
  place(id: string, rect: DOMRect | null, anchor?: symbol, mode: AppDisplayMode = "inline"): void {
    const page = this.pages.find(page => page.id === id)
    if (!page) return
    if (anchor) {
      let anchors = this.anchors.get(id)
      if (!anchors) { anchors = new Map(); this.anchors.set(id, anchors) }
      const prior = anchors.get(anchor)
      if (rect && (!prior?.rect || prior.mode !== mode)) page.expanded = false
      anchors.set(anchor, { rect, mode })
      this.applyPlacement(page)
    } else this.applyPlacement(page, { rect, mode })
  }
  private applyPlacement(page: ResidentAppPage, direct?: Placement): void {
    const candidates = [...(this.anchors.get(page.id)?.values() ?? [])].filter(item => item.rect)
    const placement = direct ?? candidates.at(-1)
    const mode = page.expanded ? "fullscreen" : placement?.mode ?? "inline"
    let rect = placement?.rect ?? null
    // No visible placement before the official handshake confirms support.
    if (!page.modes?.includes(mode)) rect = null
    page.controller.setVisible(!!rect)
    if (rect) page.transport?.setDisplayMode(mode)
    const element = page.element
    if (!element) return
    element.dataset.displayMode = mode
    element.style.visibility = rect ? "visible" : "hidden"
    element.style.pointerEvents = rect ? "auto" : "none"
    element.inert = !rect
    element.setAttribute("aria-hidden", String(!rect))
    if (rect) Object.assign(element.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` })
  }
  private requestDisplayMode(page: ResidentAppPage, mode: AppDisplayMode): void {
    const visible = [...(this.anchors.get(page.id)?.values() ?? [])].filter(item => item.rect)
    if (!page.modes?.includes(mode) || !visible.length)
      throw new Error("plugin_app_display_mode_unavailable")
    page.expanded = mode === "fullscreen"
    this.applyPlacement(page, { rect: visible.at(-1)!.rect, mode })
  }
  releaseAnchor(id: string, anchor: symbol): void {
    const anchors = this.anchors.get(id)
    anchors?.delete(anchor)
    const page = this.pages.find(item => item.id === id)
    if (page) this.applyPlacement(page)
    if (!anchors?.size) this.anchors.delete(id)
  }
  async remove(id: string, explicit = false): Promise<void> {
    const active = this.removing.get(id)
    if (active) return active
    const page = this.pages.find(item => item.id === id)
    if (!page) return
    const operation = (async () => {
      // A rejected fixed-revision close keeps the iframe, draft, and transport intact.
      await page.controller.dispose(explicit)
      this.place(id, null)
      this.anchors.delete(id)
      await page.transport?.close()
      this.pages = this.pages.filter(item => item !== page); this.emit()
    })()
    this.removing.set(id, operation)
    try { await operation } finally { if (this.removing.get(id) === operation) this.removing.delete(id) }
  }
  async refresh(): Promise<void> {
    await Promise.allSettled(this.pages.map(async page => {
      await page.controller.refresh()
      if (page.controller.state.app.status !== "open") await this.remove(page.id)
    }))
  }
  async dispose(): Promise<void> { await Promise.allSettled(this.pages.map(page => this.remove(page.id))) }
}

import { webContents, type WebContents } from "electron"
import { isAbsolute, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type {
  BrowserAction,
  BrowserDeveloperExecuteInput,
  BrowserDeveloperResult,
  BrowserHost,
  BrowserObservation,
} from "@vykor/server"
import { getDesktopPreferences } from "../settings/desktop-preferences"
import {
  BrowserDeveloperInspector,
  describeDeveloperAction,
  resolveDeveloperScope,
  sanitizeUrl,
  type DeveloperGuest,
  type DeveloperScope,
} from "./browser-developer-inspector"
import {
  ELEMENT_INSPECT_SCRIPT,
  fingerprintPage,
  waitForPageUpdate,
  type InspectedPage,
} from "./browser-page-inspection"
import {
  capDeveloperDiagnosticsResult,
  capDeveloperReadResult,
} from "./browser-developer-result-limits"
import {
  BrowserAnnotationController,
  type AnnotationPageContext,
} from "./browser-annotation-controller"
import type {
  AddAnnotationInput,
  AnnotationIdInput,
  SetAnnotationModeInput,
  BrowserAnnotationSnapshot,
} from "../../../shared/browser-annotation"

export interface BrowserRequestScope {
  signal: AbortSignal
  getOwnerSessionToken: (ownerId: number, sessionId: string) => object | undefined
}

type BrowserRequestGuard = {
  signal: AbortSignal
  assertCurrent: (checkPage?: boolean) => void
  attachOpenedTab: (tabId: string) => void
  refreshPage: () => void
}

type ElementTarget = {
  webContentsId: number
  sessionId: string
  pageRevision: number
  pageUrl: string
  selector: string
  role: string
  name: string
  href?: string
  requiresConfirmation: boolean
}

export class BrowserAgentService implements BrowserHost {
  private readonly guestsByWindow = new Map<number, Set<number>>()
  private readonly tabs = new Map<string, { ownerId: number; webContentsId: number }>()
  private readonly targets = new Map<string, ElementTarget>()
  private readonly annotations = new BrowserAnnotationController()
  private readonly annotationPageRevisions = new Map<number, number>()
  private readonly approvedOrigins = new Map<string, Set<string>>()
  private readonly pageFingerprints = new Map<number, string>()
  private readonly developerInspector = new BrowserDeveloperInspector()
  private readonly navigationEpochs = new Map<number, number>()
  private developerGeneration = 0
  private activeDeveloperRequestSessionId: string | null = null
  private readonly queuedDeveloperRequests = new Set<{ sessionId: string; cancelled: boolean }>()
  private activeTabId: string | null = null
  private targetSequence = 0
  private activeTabRevision = 0
  private openTabRequestHandler?: { request: () => void; ownerId?: number }

  listOriginApprovals(): Array<{ sessionId: string; origin: string }> {
    return [...this.approvedOrigins].flatMap(([sessionId, origins]) =>
      [...origins].map(origin => ({ sessionId, origin })))
  }

  revokeOriginApproval(sessionId: string, origin: string): void {
    this.approvedOrigins.get(sessionId)?.delete(origin)
    // An inspection queued before revocation must not retain its site access.
    this.stopDeveloperDiagnostics()
  }
  private readonly activeTabWaiters = new Set<(tabId: string) => void>()
  // ponytail: serialize browser operations globally; use per-tab queues only if throughput becomes a measured bottleneck.
  private operationQueue: Promise<void> = Promise.resolve()

  constructor(private readonly options: { isDeveloperModeEnabled?: () => boolean } = {}) {}

  trackGuest(ownerId: number, guest: WebContents): void {
    this.annotationPageRevisions.set(guest.id, 0)
    const guests = this.guestsByWindow.get(ownerId) ?? new Set<number>()
    guests.add(guest.id)
    this.guestsByWindow.set(ownerId, guests)
    const onMainNavigation = (details: unknown, url: unknown): void => {
      const info =
        details && typeof details === "object" ? (details as Record<string, unknown>) : undefined
      if (info?.isMainFrame !== true || info?.isSameDocument === true) return
      const nextUrl = typeof info?.url === "string" ? info.url : typeof url === "string" ? url : ""
      const epoch = (this.navigationEpochs.get(guest.id) ?? 0) + 1
      this.navigationEpochs.set(guest.id, epoch)
      const revision = (this.annotationPageRevisions.get(guest.id) ?? 0) + 1
      this.annotationPageRevisions.set(guest.id, revision)
      this.annotations.navigationStarted(guest.id, revision)
      this.developerInspector.handleNavigationStart(guest.id, nextUrl || undefined, epoch)
    }
    guest.on("did-start-navigation", onMainNavigation)
    guest.on("did-redirect-navigation", onMainNavigation)
    let previousMainUrl = guest.getURL()
    const ready = (): void => {
      previousMainUrl = guest.getURL()
      this.annotations.pageReady(
        guest.id,
        previousMainUrl,
        this.annotationPageRevisions.get(guest.id) ?? 0
      )
    }
    guest.on("dom-ready", ready)
    guest.on("did-stop-loading", ready)
    guest.on("did-navigate-in-page", (_event, url: string, isMainFrame: boolean) => {
      if (!isMainFrame || url === previousMainUrl) return
      const revision = (this.annotationPageRevisions.get(guest.id) ?? 0) + 1
      this.annotationPageRevisions.set(guest.id, revision)
      this.annotations.navigationStarted(guest.id, revision)
      this.annotations.pageReady(guest.id, url, revision)
      previousMainUrl = url
    })
    guest.once("destroyed", () => {
      this.guestsByWindow.get(ownerId)?.delete(guest.id)
      for (const [tabId, tab] of this.tabs) {
        if (tab.webContentsId === guest.id) {
          this.tabs.delete(tabId)
          if (this.activeTabId === tabId) this.updateActiveTab(null)
        }
      }
      this.annotations.release(guest.id)
      this.annotationPageRevisions.delete(guest.id)
      this.pageFingerprints.delete(guest.id)
      this.navigationEpochs.delete(guest.id)
      if (this.developerInspector.summary()?.webContentsId === guest.id)
        this.stopDeveloperDiagnostics()
    })
  }

  setOpenTabRequestHandler(handler?: () => void, ownerId?: number): void {
    this.openTabRequestHandler = handler ? { request: handler, ownerId } : undefined
  }

  private updateActiveTab(tabId: string | null): void {
    if (this.activeTabId !== tabId) this.activeTabRevision += 1
    this.activeTabId = tabId
  }

  bindTab(ownerId: number, tabId: string, webContentsId: number): void {
    if (!this.guestsByWindow.get(ownerId)?.has(webContentsId)) {
      throw new Error("Browser tab is not attached to this application window.")
    }
    if (!/^[\w-]{1,100}$/.test(tabId)) throw new Error("Invalid browser tab ID.")
    const previous = this.tabs.get(tabId)
    if (previous?.ownerId === ownerId && previous.webContentsId === webContentsId) return
    if (previous) {
      this.annotations.release(previous.webContentsId)
      this.developerGeneration += 1
      if (this.developerInspector.summary()?.tabId === tabId) {
        this.developerInspector.stopDiagnostics("tab rebound")
      }
    }
    this.tabs.set(tabId, { ownerId, webContentsId })
  }

  setActiveTab(ownerId: number, tabId: string | null): void {
    if (tabId === null) {
      if (this.activeTabId && this.tabs.get(this.activeTabId)?.ownerId === ownerId) {
        const previous = this.tabs.get(this.activeTabId)!
        this.annotations.suspend(previous.webContentsId)
        this.stopDeveloperDiagnostics()
        this.updateActiveTab(null)
      }
      return
    }
    const tab = this.tabs.get(tabId)
    if (!tab || tab.ownerId !== ownerId) throw new Error("Unknown browser tab.")
    if (this.activeTabId !== tabId && this.activeTabId) {
      const previous = this.tabs.get(this.activeTabId)
      if (previous) this.annotations.suspend(previous.webContentsId)
    }
    if (this.activeTabId !== tabId) this.stopDeveloperDiagnostics()
    this.updateActiveTab(tabId)
    for (const resolve of this.activeTabWaiters) resolve(tabId)
  }

  unbindTab(ownerId: number, tabId: string): void {
    if (this.tabs.get(tabId)?.ownerId !== ownerId) return
    this.annotations.suspend(this.tabs.get(tabId)!.webContentsId)
    if (this.activeTabId === tabId || this.developerInspector.summary()?.tabId === tabId) {
      this.stopDeveloperDiagnostics()
    }
    this.tabs.delete(tabId)
    if (this.activeTabId === tabId) this.updateActiveTab(null)
  }

  /** Immediately stop any active developer capture. Safe to call synchronously. */
  stopDeveloperDiagnostics(): boolean {
    this.developerGeneration += 1
    for (const request of this.queuedDeveloperRequests) request.cancelled = true
    return this.developerInspector.stopDiagnostics("stopped")
  }

  private annotationPage(ownerId: number, tabId: string): AnnotationPageContext {
    const tab = this.tabs.get(tabId)
    const contents =
      tab && tab.ownerId === ownerId ? webContents.fromId(tab.webContentsId) : undefined
    if (!contents || contents.isDestroyed() || this.activeTabId !== tabId)
      throw new Error("浏览器标签页已变化，请重新选择")
    const pageRevision = this.annotationPageRevisions.get(contents.id) ?? 0
    const pageUrl = contents.getURL()
    const ready = !(contents.isLoadingMainFrame?.() ?? contents.isLoading())
    if (ready) this.annotations.pageReady(contents.id, pageUrl, pageRevision)
    return {
      tabId,
      contents,
      pageUrl,
      pageRevision,
      ready,
      assertCurrent: () => {
        const actual = this.tabs.get(tabId)
        if (
          this.activeTabId !== tabId ||
          actual?.ownerId !== ownerId ||
          actual.webContentsId !== contents.id ||
          contents.isDestroyed() ||
          (this.annotationPageRevisions.get(contents.id) ?? 0) !== pageRevision ||
          contents.getURL() !== pageUrl
        ) {
          throw new Error("页面已变化，请重新选择目标")
        }
      },
    }
  }

  async readAnnotations(ownerId: number, tabId: string): Promise<BrowserAnnotationSnapshot> {
    return this.annotations.read(this.annotationPage(ownerId, tabId))
  }
  async setAnnotationMode(
    ownerId: number,
    input: SetAnnotationModeInput
  ): Promise<BrowserAnnotationSnapshot> {
    return this.annotations.setMode(this.annotationPage(ownerId, input.tabId), input)
  }
  async addAnnotation(
    ownerId: number,
    input: AddAnnotationInput
  ): Promise<BrowserAnnotationSnapshot> {
    return this.annotations.add(this.annotationPage(ownerId, input.tabId), input)
  }
  async focusAnnotation(
    ownerId: number,
    input: AnnotationIdInput
  ): Promise<BrowserAnnotationSnapshot> {
    return this.annotations.focus(this.annotationPage(ownerId, input.tabId), input)
  }
  async removeAnnotation(
    ownerId: number,
    input: AnnotationIdInput
  ): Promise<BrowserAnnotationSnapshot> {
    return this.annotations.remove(this.annotationPage(ownerId, input.tabId), input)
  }

  private requestGuard(
    sessionId: string,
    scope: BrowserRequestScope
  ): BrowserRequestGuard {
    let tabId = this.activeTabId
    let tab = tabId ? this.tabs.get(tabId) : undefined
    const opener = this.openTabRequestHandler
    const ownerId = tab?.ownerId ?? opener?.ownerId
    const token = ownerId === undefined ? undefined : scope.getOwnerSessionToken(ownerId, sessionId)
    if (ownerId === undefined || !token) {
      throw new Error("Open this session in the desktop window to use its browser.")
    }

    let tabRevision = this.activeTabRevision
    let pageRevision = 0
    let pageUrl: string | undefined
    const refreshPage = (): void => {
      pageRevision = this.annotationPageRevisions.get(tab?.webContentsId ?? -1) ?? 0
      pageUrl = tab ? webContents.fromId(tab.webContentsId)?.getURL() : undefined
    }
    const assertOwner = (): void => {
      scope.signal.throwIfAborted()
      if (scope.getOwnerSessionToken(ownerId, sessionId) !== token) {
        throw new Error("The window session changed while the Browser tool was waiting.")
      }
    }
    const assertCurrent = (checkPage = true): void => {
      assertOwner()
      if (this.activeTabRevision !== tabRevision || this.activeTabId !== tabId ||
          (tabId ? this.tabs.get(tabId) !== tab : this.openTabRequestHandler !== opener)) {
        throw new Error("The active browser tab changed while the tool was waiting. Inspect the page again.")
      }
      if (!tab) return
      const contents = webContents.fromId(tab.webContentsId)
      if (!contents || contents.isDestroyed()) throw new Error("The browser tab is no longer available.")
      if (checkPage && ((this.annotationPageRevisions.get(contents.id) ?? 0) !== pageRevision ||
          contents.getURL() !== pageUrl)) {
        throw new Error("The browser page changed while the tool was waiting. Inspect the page again.")
      }
    }
    refreshPage()
    assertCurrent()
    return {
      signal: scope.signal,
      assertCurrent,
      refreshPage,
      attachOpenedTab: (openedTabId) => {
        assertOwner()
        tab = this.tabs.get(openedTabId)
        if (tab?.ownerId !== ownerId) throw new Error("The browser opened in a different window.")
        tabId = openedTabId
        tabRevision = this.activeTabRevision
        refreshPage()
        assertCurrent()
      },
    }
  }

  private guardApproval(
    approve: (question: string) => Promise<boolean>,
    guard?: BrowserRequestGuard
  ): (question: string) => Promise<boolean> {
    if (!guard) return approve
    return async (question) => {
      guard.assertCurrent()
      const allowed = await approve(question)
      guard.assertCurrent()
      return allowed
    }
  }

  async execute(
    input: Parameters<BrowserHost["execute"]>[0],
    scope?: BrowserRequestScope
  ): Promise<BrowserObservation> {
    const requestedTabId = this.activeTabId
    const guard = scope && this.requestGuard(input.sessionId, scope)
    return this.enqueue(() => this.executeOnTab(
      { ...input, approve: this.guardApproval(input.approve, guard) },
      requestedTabId,
      guard
    ))
  }

  async executeDeveloper(
    input: BrowserDeveloperExecuteInput,
    scope?: BrowserRequestScope
  ): Promise<BrowserDeveloperResult> {
    const guard = scope && this.requestGuard(input.sessionId, scope)
    if (input.action.action === "stop_diagnostics") return this.executeDeveloperOnTab(input, guard)
    input = {
      ...input,
      approveOrigin: this.guardApproval(input.approveOrigin, guard),
      approveDeveloper: this.guardApproval(input.approveDeveloper, guard),
    }
    const request = { sessionId: input.sessionId, cancelled: false }
    this.queuedDeveloperRequests.add(request)
    return this.enqueue(async () => {
      this.queuedDeveloperRequests.delete(request)
      if (request.cancelled) throw new Error("Browser developer request was cancelled.")
      this.activeDeveloperRequestSessionId = input.sessionId
      try {
        return await this.executeDeveloperOnTab(input, guard)
      } finally {
        this.activeDeveloperRequestSessionId = null
      }
    })
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const operation = this.operationQueue.then(task)
    this.operationQueue = operation.then(
      () => undefined,
      () => undefined
    )
    return operation
  }

  private async executeOnTab(
    input: Parameters<BrowserHost["execute"]>[0],
    requestedTabId: string | null,
    guard?: BrowserRequestGuard
  ): Promise<BrowserObservation> {
    guard?.assertCurrent()
    const openingTab = !requestedTabId
    if (openingTab && input.action.action !== "navigate") {
      throw new Error("Use Browser navigate with a URL to open a page.")
    }
    if (openingTab && input.action.action === "navigate") {
      await this.requireOrigin(input.action.url, input.sessionId, input.cwd, input.approve)
    }
    guard?.assertCurrent()
    const tabId = requestedTabId ?? (await this.openBrowserTab(guard?.signal))
    if (openingTab) guard?.attachOpenedTab(tabId)
    const tab = this.tabs.get(tabId)
    const contents = tab ? webContents.fromId(tab.webContentsId) : undefined
    if (!contents || contents.isDestroyed())
      throw new Error("Open a page in the desktop browser first.")
    this.assertActiveTab(tabId, contents)

    const destination = input.action.action === "navigate" ? input.action.url : contents.getURL()
    if (!openingTab) {
      await this.requireOrigin(destination, input.sessionId, input.cwd, input.approve)
    }
    guard?.assertCurrent()
    this.assertActiveTab(tabId, contents)

    if (input.action.action === "click") {
      const target = this.getElementTarget(contents, input.sessionId, input.action.elementId)
      if (target.href) {
        const link = new URL(target.href, contents.getURL())
        if (link.protocol === "http:" || link.protocol === "https:" || link.protocol === "file:") {
          await this.requireOrigin(link.href, input.sessionId, input.cwd, input.approve)
          guard?.assertCurrent()
          this.assertActiveTab(tabId, contents)
        }
      }
    }

    if (input.action.action === "navigate" || input.action.action === "scroll") {
      await this.annotations.pauseForBrowserAction(contents)
      guard?.assertCurrent()
      this.assertActiveTab(tabId, contents)
    }
    if (input.action.action === "navigate") {
      await this.withNavigationGuard(
        contents,
        input.sessionId,
        input.cwd,
        async () => {
          const signal = guard?.signal
          signal?.throwIfAborted()
          const stopLoading = (): void => {
            if (!contents.isDestroyed()) contents.stop()
          }
          signal?.addEventListener("abort", stopLoading, { once: true })
          try {
            await contents.loadURL(destination)
          } finally {
            signal?.removeEventListener("abort", stopLoading)
          }
        },
        guard
      )
    } else if (input.action.action === "click" || input.action.action === "type") {
      const action = input.action
      await this.withNavigationGuard(
        contents,
        input.sessionId,
        input.cwd,
        async () => await this.applyElementAction(contents, action, input, tabId, guard),
        guard
      )
    } else if (input.action.action === "scroll") {
      const amount = Math.max(100, Math.min(input.action.amount ?? 600, 1_200))
      await contents.executeJavaScript(
        `window.scrollBy(0, ${input.action.direction === "down" ? amount : -amount})`
      )
    }

    if (input.action.action === "navigate" || input.action.action === "click") {
      // These operations may intentionally replace the page. Read the new page only
      // while the originating window, session and tab still match.
      guard?.assertCurrent(false)
      if (guard && !this.isApprovedDestination(contents.getURL(), input.sessionId, input.cwd)) {
        throw new Error("The browser left the approved site. Inspect the page again.")
      }
      guard?.refreshPage()
    }
    guard?.assertCurrent()
    const page = (await contents.executeJavaScript(ELEMENT_INSPECT_SCRIPT)) as InspectedPage
    guard?.assertCurrent()
    this.assertActiveTab(tabId, contents)
    const screenshotBytes =
      input.action.action === "inspect" && input.includeScreenshot
        ? await this.capture(contents)
        : undefined
    guard?.assertCurrent()
    this.assertActiveTab(tabId, contents)
    const elements = this.rememberTargets(contents, input.sessionId, page.elements)
    this.pageFingerprints.set(contents.id, fingerprintPage(page))
    return {
      url: page.url,
      title: page.title,
      pageText: page.pageText,
      elements,
      ...(screenshotBytes ? { screenshotBytes } : {}),
      annotations: this.annotations.project(
        contents.id,
        page.url,
        this.annotationPageRevisions.get(contents.id) ?? 0
      ),
    }
  }

  async dispose(): Promise<void> {
    this.developerInspector.stopDiagnostics("disposed")
    this.guestsByWindow.clear()
    this.tabs.clear()
    this.targets.clear()
    for (const id of this.annotationPageRevisions.keys()) this.annotations.release(id)
    this.annotationPageRevisions.clear()
    this.approvedOrigins.clear()
    this.pageFingerprints.clear()
    this.activeTabWaiters.clear()
    this.navigationEpochs.clear()
  }

  private developerModeEnabled(): boolean {
    if (this.options.isDeveloperModeEnabled) return this.options.isDeveloperModeEnabled()
    try {
      return getDesktopPreferences().browserDeveloperMode === true
    } catch {
      return false
    }
  }

  private activeDeveloperGuest(): { tabId: string; contents: WebContents } | null {
    const tabId = this.activeTabId
    if (!tabId) return null
    const tab = this.tabs.get(tabId)
    const contents = tab ? webContents.fromId(tab.webContentsId) : undefined
    if (!contents || contents.isDestroyed()) return null
    return { tabId, contents }
  }

  private async executeDeveloperOnTab(
    input: BrowserDeveloperExecuteInput,
    guard?: BrowserRequestGuard
  ): Promise<BrowserDeveloperResult> {
    guard?.assertCurrent()
    const action = input.action

    // Stopping is always allowed so a stuck capture can be cleaned up.
    if (action.action === "stop_diagnostics") {
      const owner =
        this.developerInspector.summary()?.sessionId ?? this.activeDeveloperRequestSessionId
      if (owner && owner !== input.sessionId) {
        throw new Error("Another session owns the active browser diagnostics capture.")
      }
      for (const request of this.queuedDeveloperRequests) {
        if (request.sessionId === input.sessionId) request.cancelled = true
      }
      this.developerGeneration += 1
      const stopped = this.developerInspector.stopDiagnostics("requested")
      return {
        action: "stop_diagnostics",
        url: "",
        data: { stopped },
      }
    }

    if (!this.developerModeEnabled()) {
      this.developerInspector.stopDiagnostics("developer mode disabled")
      throw new Error("Browser developer mode is off in Desktop settings.")
    }

    const active = this.activeDeveloperGuest()
    if (!active) throw new Error("Open a page in the desktop browser first.")
    const { tabId, contents } = active
    const url = contents.getURL()
    const resultUrl = sanitizeUrl(url)
    const scope = resolveDeveloperScope(url, input.cwd)
    if (!scope) {
      throw new Error(
        "Browser developer inspection supports HTTP, HTTPS, and workspace-local file pages only."
      )
    }
    const epoch = this.navigationEpochs.get(contents.id) ?? 0
    const generation = this.developerGeneration
    const guest = contents as unknown as DeveloperGuest

    if (action.action === "read_diagnostics") {
      const page = this.developerInspector.readDiagnostics(guest, {
        sessionId: input.sessionId,
        scope: scope.scope,
        navigationEpoch: epoch,
      })
      this.assertDeveloperIdentity(
        input.sessionId,
        tabId,
        contents,
        scope.scope,
        epoch,
        generation,
        input.cwd
      )
      return capDeveloperDiagnosticsResult({
        action: "read_diagnostics",
        url: page.url,
        data: page,
        ...(page.truncated ? { truncated: true } : {}),
      })
    }

    if (this.developerInspector.active && !this.developerInspector.ownsSession(input.sessionId)) {
      throw new Error("Another session is already capturing browser diagnostics.")
    }

    const snapshot = {
      tabId,
      webContentsId: contents.id,
      scope: scope.scope,
      epoch,
      generation,
    }
    await this.requireOrigin(scope.url, input.sessionId, input.cwd, input.approveOrigin)
    guard?.assertCurrent()
    this.assertDeveloperSnapshot(snapshot, input.cwd)
    const approved = await input.approveDeveloper(this.developerReason(scope, action.action))
    guard?.assertCurrent()
    this.assertDeveloperSnapshot(snapshot, input.cwd)
    if (!approved) {
      throw new Error(
        `Browser developer ${describeDeveloperAction(action.action)} was not approved.`
      )
    }

    if (action.action === "start_diagnostics") {
      const { expiresAt } = await this.developerInspector.startDiagnostics(guest, {
        sessionId: input.sessionId,
        tabId,
        scope: scope.scope,
        cwd: input.cwd,
        url,
        navigationEpoch: epoch,
      })
      try {
        guard?.assertCurrent()
        this.assertDeveloperIdentity(
          input.sessionId,
          tabId,
          contents,
          scope.scope,
          epoch,
          generation,
          input.cwd
        )
        if (!this.developerInspector.ownsSession(input.sessionId)) {
          throw new Error("Browser diagnostics stopped while starting.")
        }
      } catch (error) {
        this.stopDeveloperDiagnostics()
        throw error
      }
      return {
        action: "start_diagnostics",
        url: resultUrl,
        data: { startedAt: Date.now(), expiresAt },
      }
    }

    if (action.action === "inspect_dom") {
      const data = await this.developerInspector.inspectDom(guest, action.selector)
      guard?.assertCurrent()
      this.assertDeveloperIdentity(
        input.sessionId,
        tabId,
        contents,
        scope.scope,
        epoch,
        generation,
        input.cwd
      )
      return capDeveloperReadResult({ action: "inspect_dom", url: resultUrl, data })
    }

    if (action.action === "inspect_styles") {
      const data = await this.developerInspector.inspectStyles(guest, action.selector)
      guard?.assertCurrent()
      this.assertDeveloperIdentity(
        input.sessionId,
        tabId,
        contents,
        scope.scope,
        epoch,
        generation,
        input.cwd
      )
      return capDeveloperReadResult({ action: "inspect_styles", url: resultUrl, data })
    }

    throw new Error("Unsupported browser developer action.")
  }

  private developerReason(scope: DeveloperScope, action: string): string {
    const target = scope.kind === "file" ? `local file ${scope.filePath}` : scope.scope
    const networkScope =
      action === "start_diagnostics"
        ? " Network results can include third-party subresource URLs requested by the main frame."
        : ""
    return (
      `Allow Browser developer inspection of ${target}? Category: ${describeDeveloperAction(action)}. ` +
      `It inspects the active tab's main frame.${networkScope} Results may contain internal page data, and the page ` +
      `can write secrets into DOM text or console output. This approval applies to this single request only.`
    )
  }

  private assertDeveloperSnapshot(
    snapshot: {
      tabId: string
      webContentsId: number
      scope: string
      epoch: number
      generation: number
    },
    cwd: string
  ): void {
    if (!this.developerModeEnabled()) {
      throw new Error("Browser developer mode was turned off in Desktop settings.")
    }
    if (this.activeTabId !== snapshot.tabId) {
      throw new Error(
        "The active browser tab changed while the tool was waiting. Inspect the page again."
      )
    }
    if (this.tabs.get(snapshot.tabId)?.webContentsId !== snapshot.webContentsId) {
      throw new Error("The browser tab changed while the tool was waiting. Inspect the page again.")
    }
    if (this.developerGeneration !== snapshot.generation) {
      throw new Error("The browser tab changed while the tool was waiting. Inspect the page again.")
    }
    const current = webContents.fromId(snapshot.webContentsId)
    if (!current || current.isDestroyed()) {
      throw new Error("The browser tab is no longer available.")
    }
    if ((this.navigationEpochs.get(snapshot.webContentsId) ?? 0) !== snapshot.epoch) {
      throw new Error(
        "The browser page changed while the tool was waiting. Inspect the page again."
      )
    }
    const scope = resolveDeveloperScope(current.getURL(), cwd)
    if (!scope || scope.scope !== snapshot.scope) {
      throw new Error(
        "The browser page changed while the tool was waiting. Inspect the page again."
      )
    }
  }

  private assertDeveloperIdentity(
    sessionId: string,
    tabId: string,
    contents: WebContents,
    scope: string,
    epoch: number,
    generation: number,
    cwd: string
  ): void {
    if (
      this.activeTabId !== tabId ||
      this.tabs.get(tabId)?.webContentsId !== contents.id ||
      contents.isDestroyed()
    ) {
      throw new Error(
        "The active browser tab changed while the tool was waiting. Inspect the page again."
      )
    }
    if (!this.developerModeEnabled()) {
      this.developerInspector.stopDiagnostics("developer mode disabled")
      throw new Error("Browser developer mode was turned off in Desktop settings.")
    }
    if (this.developerGeneration !== generation) {
      throw new Error("The browser tab changed while the tool was waiting. Inspect the page again.")
    }
    if ((this.navigationEpochs.get(contents.id) ?? 0) !== epoch) {
      throw new Error(
        "The browser page changed while the tool was waiting. Inspect the page again."
      )
    }
    const currentScope = resolveDeveloperScope(contents.getURL(), cwd)
    if (!currentScope || currentScope.scope !== scope) {
      throw new Error(
        "The browser page changed while the tool was waiting. Inspect the page again."
      )
    }
    if (this.developerInspector.active && !this.developerInspector.ownsSession(sessionId)) {
      throw new Error("Another session is already capturing browser diagnostics.")
    }
  }

  private async openBrowserTab(signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted()
    const opener = this.openTabRequestHandler
    if (!opener) throw new Error("Open a page in the desktop browser first.")
    const activeTab = this.activeTabId && this.tabs.has(this.activeTabId) ? this.activeTabId : null
    if (activeTab) return activeTab

    return await new Promise<string>((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timer)
        signal?.removeEventListener("abort", onAbort)
        this.activeTabWaiters.delete(onReady)
      }
      const onAbort = (): void => {
        cleanup()
        reject(signal?.reason)
      }
      const onReady = (tabId: string): void => {
        if (opener.ownerId !== undefined && this.tabs.get(tabId)?.ownerId !== opener.ownerId) {
          return
        }
        cleanup()
        resolve(tabId)
      }
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error("Timed out while opening the desktop browser tab."))
      }, 15_000)
      this.activeTabWaiters.add(onReady)
      signal?.addEventListener("abort", onAbort, { once: true })
      try {
        opener.request()
      } catch (error) {
        cleanup()
        reject(error)
      }
    })
  }

  private async requireOrigin(
    urlValue: string,
    sessionId: string,
    cwd: string,
    approve: (question: string) => Promise<boolean>
  ): Promise<void> {
    let url: URL
    try {
      url = new URL(urlValue)
    } catch {
      throw new Error("The browser page has no valid URL.")
    }
    if (url.protocol === "file:") {
      const target = resolve(fileURLToPath(url))
      const root = resolve(cwd)
      const relativePath = relative(root, target)
      if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
        throw new Error("Browser navigation to local files is limited to the current workspace.")
      }
    } else if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error("Only HTTP, HTTPS, and workspace-local file pages are supported.")
    }
    const origin = url.protocol === "file:" ? "local files in this workspace" : url.origin
    const allowed = this.approvedOrigins.get(sessionId) ?? new Set<string>()
    if (allowed.has(origin)) return
    if (
      !(await approve(
        `Allow the Browser tool to inspect and interact with ${origin} for this session? Reply yes to allow.`
      ))
    ) {
      throw new Error(`Browser access to ${origin} was not approved.`)
    }
    allowed.add(origin)
    this.approvedOrigins.set(sessionId, allowed)
  }

  private async withNavigationGuard<T>(
    contents: WebContents,
    sessionId: string,
    cwd: string,
    operation: () => Promise<T>,
    requestGuard?: BrowserRequestGuard
  ): Promise<T> {
    let blockedOrigin: string | null = null
    const guard = (event: Electron.Event, destination: string): void => {
      try {
        requestGuard?.assertCurrent(false)
      } catch {
        event.preventDefault()
        return
      }
      if (this.isApprovedDestination(destination, sessionId, cwd)) return
      event.preventDefault()
      try {
        blockedOrigin = new URL(destination).origin
      } catch {
        blockedOrigin = "an unsupported destination"
      }
    }
    contents.on("will-navigate", guard)
    contents.on("will-redirect", guard)
    try {
      const result = await operation()
      if (blockedOrigin) {
        throw new Error(
          `Navigation to ${blockedOrigin} was blocked. Use Browser navigate to request access first.`
        )
      }
      return result
    } finally {
      contents.off("will-navigate", guard)
      contents.off("will-redirect", guard)
    }
  }

  private isApprovedDestination(destination: string, sessionId: string, cwd: string): boolean {
    try {
      const url = new URL(destination)
      if (url.protocol === "file:") {
        const target = resolve(fileURLToPath(url))
        const relativePath = relative(resolve(cwd), target)
        return (
          !relativePath.startsWith("..") &&
          !isAbsolute(relativePath) &&
          Boolean(this.approvedOrigins.get(sessionId)?.has("local files in this workspace"))
        )
      }
      return (
        (url.protocol === "http:" || url.protocol === "https:") &&
        Boolean(this.approvedOrigins.get(sessionId)?.has(url.origin))
      )
    } catch {
      return false
    }
  }

  private rememberTargets(
    contents: WebContents,
    sessionId: string,
    elements: Array<{
      selector: string
      role: string
      name: string
      href: string
      value: string
      requiresConfirmation: boolean
    }>
  ): NonNullable<BrowserObservation["elements"]> {
    for (const [id, target] of this.targets) {
      if (target.webContentsId === contents.id) this.targets.delete(id)
    }
    const pageRevision = this.annotationPageRevisions.get(contents.id) ?? 0
    const pageUrl = contents.getURL()
    const snapshotId = ++this.targetSequence
    const result: NonNullable<BrowserObservation["elements"]> = []
    for (const [index, element] of elements.entries()) {
      const id = `e${snapshotId}-${index}`
      this.targets.set(id, {
        webContentsId: contents.id,
        sessionId,
        pageRevision,
        pageUrl,
        selector: element.selector,
        role: element.role,
        name: element.name,
        href: element.href,
        requiresConfirmation: element.requiresConfirmation,
      })
      result.push({
        id,
        role: element.role,
        name: element.name,
        href: element.href,
        value: element.value,
        requiresConfirmation: element.requiresConfirmation,
      })
    }
    return result
  }

  private getElementTarget(contents: WebContents, sessionId: string, elementId: string): ElementTarget {
    const target = this.targets.get(elementId)
    if (!target || target.webContentsId !== contents.id || target.sessionId !== sessionId ||
        target.pageRevision !== (this.annotationPageRevisions.get(contents.id) ?? 0) ||
        target.pageUrl !== contents.getURL()) {
      throw new Error("That element ID is stale. Inspect the page again.")
    }
    return target
  }

  private async applyElementAction(
    contents: WebContents,
    action: Extract<BrowserAction, { action: "click" | "type" }>,
    input: Pick<Parameters<BrowserHost["execute"]>[0], "sessionId" | "approve">,
    tabId: string,
    guard?: BrowserRequestGuard
  ): Promise<void> {
    const target = this.getElementTarget(contents, input.sessionId, action.elementId)
    if (target.requiresConfirmation) {
      const allowed = await input.approve(
        action.action === "click"
          ? `Confirm clicking “${target.name || target.role}” on ${contents.getURL()}? This action may submit or change data.`
          : `Confirm entering sensitive information in “${target.name || target.role}” on ${contents.getURL()}?`
      )
      if (!allowed) throw new Error("The browser action was not approved.")
    }
    this.assertActiveTab(tabId, contents)
    const selector = JSON.stringify(target.selector)
    await this.annotations.pauseForBrowserAction(contents)
    guard?.assertCurrent()
    this.assertActiveTab(tabId, contents)
    this.getElementTarget(contents, input.sessionId, action.elementId)
    const role = JSON.stringify(target.role)
    const name = JSON.stringify(target.name)
    const text = action.action === "type" ? JSON.stringify(action.text.slice(0, 4_000)) : '""'
    const operation =
      action.action === "click"
        ? "const target = el; setTimeout(() => { if (!target.isConnected) return; try { target.click(); } catch { /* Navigation may destroy this execution context. */ } }, 0); return 'click queued';"
        : "if (!('value' in el) && !el.isContentEditable) throw new Error('Target is not editable'); if (el.isContentEditable) el.textContent = text; else { const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set; if (setter) setter.call(el, text); else el.value = text; } el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text })); el.dispatchEvent(new Event('change', { bubbles: true })); return 'typed';"
    const result = await contents.executeJavaScript(
      `(() => { const el = document.querySelector(${selector}); if (!el) throw new Error('Target is no longer present'); const actualRole = el.getAttribute('role') || ({ BUTTON: 'button', A: 'link', INPUT: el.type === 'checkbox' ? 'checkbox' : 'textbox', TEXTAREA: 'textbox', SELECT: 'combobox' }[el.tagName] || 'control'); const actualName = (el.getAttribute('aria-label') || el.getAttribute('title') || [...(el.labels || [])].map((label) => label.innerText).join(' ') || el.innerText || el.getAttribute('placeholder') || '').trim().replace(/\\s+/g, ' ').slice(0, 180); if (actualRole !== ${role} || actualName !== ${name}) throw new Error('Page changed; inspect it again before acting'); const text = ${text}; ${operation} })()`,
      true
    )
    if (typeof result !== "string") throw new Error("The browser action did not complete.")
    if (action.action === "click") {
      await waitForPageUpdate(contents, this.pageFingerprints.get(contents.id) ?? "", guard?.signal)
    }
  }

  private async capture(contents: WebContents): Promise<Uint8Array> {
    const image = await contents.capturePage()
    const bytes = image.toPNG()
    if (bytes.byteLength > 8 * 1024 * 1024)
      throw new Error("Browser screenshot exceeds the 8 MB limit.")
    return bytes
  }

  private assertActiveTab(tabId: string, contents: WebContents): void {
    if (this.activeTabId !== tabId || contents.isDestroyed()) {
      throw new Error(
        "The active browser tab changed while the tool was waiting. Inspect the page again."
      )
    }
  }
}

export const browserAgentService = new BrowserAgentService()

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
  type DeveloperDomView,
  type DeveloperDiagnosticsPage,
  type DeveloperScope,
} from "./browser-developer-inspector"

type ElementTarget = {
  webContentsId: number
  selector: string
  role: string
  name: string
  href?: string
  requiresConfirmation: boolean
}

type BrowserAnnotation = { target: string; comment: string }
type InspectedPage = {
  url: string
  title: string
  pageText: string
  elements: Array<{
    index: number
    selector: string
    role: string
    name: string
    href: string
    value: string
    requiresConfirmation: boolean
  }>
}

const MAX_PAGE_TEXT = 12_000
const MAX_ELEMENTS = 80
const ELEMENT_INSPECT_SCRIPT = `(() => {
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  const name = (el) => (el.getAttribute('aria-label') || el.getAttribute('title') || [...(el.labels || [])].map((label) => label.innerText).join(' ') || el.innerText || el.getAttribute('placeholder') || '').trim().replace(/\\s+/g, ' ').slice(0, 180);
  const role = (el) => el.getAttribute('role') || ({ BUTTON: 'button', A: 'link', INPUT: el.type === 'checkbox' ? 'checkbox' : 'textbox', TEXTAREA: 'textbox', SELECT: 'combobox' }[el.tagName] || 'control');
  const selector = (el) => {
    const parts = [];
    while (el && el.nodeType === 1 && el !== document.documentElement) {
      let part = el.tagName.toLowerCase();
      if (el.id) { parts.unshift(part + '#' + CSS.escape(el.id)); break; }
      const siblings = el.parentElement ? [...el.parentElement.children].filter((item) => item.tagName === el.tagName) : [];
      if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(el) + 1) + ')';
      parts.unshift(part);
      el = el.parentElement;
    }
    return parts.join('>');
  };
  const elements = [...document.querySelectorAll('button,a[href],input,textarea,select,[role=button],[role=link],[role=textbox],[contenteditable=true]')].filter(visible).slice(0, ${MAX_ELEMENTS});
  return {
    url: location.href,
    title: document.title,
    pageText: (document.body?.innerText || '').slice(0, ${MAX_PAGE_TEXT}),
    elements: elements.map((el, index) => {
      const label = name(el);
      const roleName = role(el);
      const formSubmit = Boolean(el.form) && el.matches('button:not([type=button]),input[type=submit]');
      const sensitive = /\\b(pay|purchase|buy|delete|remove|submit|send|post|confirm|place order|checkout|save changes)\\b|付款|购买|删除|提交|发送|发布|确认|下单|结账|保存/i.test(label);
      const sensitiveField = (el instanceof HTMLInputElement && /^(password|hidden|file)$/i.test(el.type)) || /password|secret|token|auth|card|cvv|cvc/i.test([el.name, el.id, el.autocomplete].join(' '));
      const value = 'value' in el ? (sensitiveField ? '[redacted]' : String(el.value).slice(0, 300)) : '';
      return { index, selector: selector(el), role: roleName, name: label, href: el instanceof HTMLAnchorElement ? el.href : '', value, requiresConfirmation: formSubmit || sensitive || sensitiveField };
    })
  };
})()`

export class BrowserAgentService implements BrowserHost {
  private readonly guestsByWindow = new Map<number, Set<number>>()
  private readonly tabs = new Map<string, { ownerId: number; webContentsId: number }>()
  private readonly targets = new Map<string, ElementTarget>()
  private readonly annotations = new Map<number, BrowserAnnotation[]>()
  private readonly approvedOrigins = new Map<string, Set<string>>()
  private readonly pageFingerprints = new Map<number, string>()
  private readonly developerInspector = new BrowserDeveloperInspector()
  private readonly navigationEpochs = new Map<number, number>()
  private developerGeneration = 0
  private activeDeveloperRequestSessionId: string | null = null
  private readonly queuedDeveloperRequests = new Set<{ sessionId: string; cancelled: boolean }>()
  private activeTabId: string | null = null
  private targetSequence = 0
  private openTabRequestHandler?: () => void
  private readonly activeTabWaiters = new Set<(tabId: string) => void>()
  // ponytail: serialize browser operations globally; use per-tab queues only if throughput becomes a measured bottleneck.
  private operationQueue: Promise<void> = Promise.resolve()

  constructor(
    private readonly options: { isDeveloperModeEnabled?: () => boolean } = {}
  ) {}

  trackGuest(ownerId: number, guest: WebContents): void {
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
      this.developerInspector.handleNavigationStart(guest.id, nextUrl || undefined, epoch)
    }
    guest.on("did-start-navigation", onMainNavigation)
    guest.on("did-redirect-navigation", onMainNavigation)
    guest.once("destroyed", () => {
      this.guestsByWindow.get(ownerId)?.delete(guest.id)
      for (const [tabId, tab] of this.tabs) {
        if (tab.webContentsId === guest.id) {
          this.tabs.delete(tabId)
          if (this.activeTabId === tabId) this.activeTabId = null
        }
      }
      this.annotations.delete(guest.id)
      this.pageFingerprints.delete(guest.id)
      this.navigationEpochs.delete(guest.id)
      if (this.developerInspector.summary()?.webContentsId === guest.id) this.stopDeveloperDiagnostics()
    })
  }

  setOpenTabRequestHandler(handler?: () => void): void {
    this.openTabRequestHandler = handler
  }

  bindTab(ownerId: number, tabId: string, webContentsId: number): void {
    if (!this.guestsByWindow.get(ownerId)?.has(webContentsId)) {
      throw new Error("Browser tab is not attached to this application window.")
    }
    if (!/^[\w-]{1,100}$/.test(tabId)) throw new Error("Invalid browser tab ID.")
    const previous = this.tabs.get(tabId)
    if (previous && previous.webContentsId !== webContentsId) {
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
        this.stopDeveloperDiagnostics()
        this.activeTabId = null
      }
      return
    }
    const tab = this.tabs.get(tabId)
    if (!tab || tab.ownerId !== ownerId) throw new Error("Unknown browser tab.")
    if (this.activeTabId !== tabId) this.stopDeveloperDiagnostics()
    this.activeTabId = tabId
    for (const resolve of this.activeTabWaiters) resolve(tabId)
    this.activeTabWaiters.clear()
  }

  unbindTab(ownerId: number, tabId: string): void {
    if (this.tabs.get(tabId)?.ownerId !== ownerId) return
    if (this.activeTabId === tabId || this.developerInspector.summary()?.tabId === tabId) {
      this.stopDeveloperDiagnostics()
    }
    this.tabs.delete(tabId)
    if (this.activeTabId === tabId) this.activeTabId = null
  }

  /** Immediately stop any active developer capture. Safe to call synchronously. */
  stopDeveloperDiagnostics(): boolean {
    this.developerGeneration += 1
    for (const request of this.queuedDeveloperRequests) request.cancelled = true
    return this.developerInspector.stopDiagnostics("stopped")
  }

  addAnnotation(ownerId: number, tabId: string, annotation: BrowserAnnotation): void {
    const tab = this.tabs.get(tabId)
    if (!tab || tab.ownerId !== ownerId) throw new Error("Unknown browser tab.")
    const target = annotation.target.trim().slice(0, 200)
    const comment = annotation.comment.trim().slice(0, 2_000)
    if (!target || !comment) throw new Error("A target and comment are required.")
    const items = this.annotations.get(tab.webContentsId) ?? []
    items.push({ target, comment })
    this.annotations.set(tab.webContentsId, items.slice(-20))
  }

  async inspectAt(ownerId: number, tabId: string, x: number, y: number): Promise<string> {
    const tab = this.tabs.get(tabId)
    const contents =
      tab && tab.ownerId === ownerId ? webContents.fromId(tab.webContentsId) : undefined
    if (!contents || contents.isDestroyed()) throw new Error("Browser tab is no longer available.")
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > 20_000 || y > 20_000) {
      throw new Error("Invalid selection coordinates.")
    }
    const target = await contents.executeJavaScript(
      `(() => { const el = document.elementFromPoint(${Math.floor(x)}, ${Math.floor(y)}); if (!el) return 'page'; const role = el.getAttribute('role') || el.tagName.toLowerCase(); const name = (el.getAttribute('aria-label') || el.getAttribute('title') || el.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 180); return role + (name ? ': ' + name : ''); })()`
    )
    return typeof target === "string" ? target : "page element"
  }

  execute(input: {
    action: BrowserAction
    sessionId: string
    cwd: string
    includeScreenshot: boolean
    approve: (question: string) => Promise<boolean>
  }): Promise<BrowserObservation> {
    const requestedTabId = this.activeTabId
    return this.enqueue(() => this.executeOnTab(input, requestedTabId))
  }

  executeDeveloper(input: BrowserDeveloperExecuteInput): Promise<BrowserDeveloperResult> {
    if (input.action.action === "stop_diagnostics") return this.executeDeveloperOnTab(input)
    const request = { sessionId: input.sessionId, cancelled: false }
    this.queuedDeveloperRequests.add(request)
    return this.enqueue(async () => {
      this.queuedDeveloperRequests.delete(request)
      if (request.cancelled) throw new Error("Browser developer request was cancelled.")
      this.activeDeveloperRequestSessionId = input.sessionId
      try {
        return await this.executeDeveloperOnTab(input)
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
    input: {
      action: BrowserAction
      sessionId: string
      cwd: string
      includeScreenshot: boolean
      approve: (question: string) => Promise<boolean>
    },
    requestedTabId: string | null
  ): Promise<BrowserObservation> {
    const openingTab = !requestedTabId
    if (openingTab && input.action.action !== "navigate") {
      throw new Error("Use Browser navigate with a URL to open a page.")
    }
    if (openingTab && input.action.action === "navigate") {
      await this.requireOrigin(input.action.url, input.sessionId, input.cwd, input.approve)
    }
    const tabId = requestedTabId ?? (await this.openBrowserTab())
    if (!tabId) throw new Error("Open a page in the desktop browser first.")
    const tab = this.tabs.get(tabId)
    const contents = tab ? webContents.fromId(tab.webContentsId) : undefined
    if (!contents || contents.isDestroyed())
      throw new Error("Open a page in the desktop browser first.")
    this.assertActiveTab(tabId, contents)

    const destination = input.action.action === "navigate" ? input.action.url : contents.getURL()
    if (!openingTab) {
      await this.requireOrigin(destination, input.sessionId, input.cwd, input.approve)
    }
    this.assertActiveTab(tabId, contents)

    if (input.action.action === "click") {
      const target = this.targets.get(input.action.elementId)
      if (target?.href) {
        const link = new URL(target.href, contents.getURL())
        if (link.protocol === "http:" || link.protocol === "https:" || link.protocol === "file:") {
          await this.requireOrigin(link.href, input.sessionId, input.cwd, input.approve)
          this.assertActiveTab(tabId, contents)
        }
      }
    }

    if (input.action.action === "navigate") {
      await this.withNavigationGuard(
        contents,
        input.sessionId,
        input.cwd,
        async () => await contents.loadURL(destination)
      )
    } else if (input.action.action === "click" || input.action.action === "type") {
      const action = input.action
      await this.withNavigationGuard(
        contents,
        input.sessionId,
        input.cwd,
        async () => await this.applyElementAction(contents, action, input.approve, tabId)
      )
    } else if (input.action.action === "scroll") {
      const amount = Math.max(100, Math.min(input.action.amount ?? 600, 1_200))
      await contents.executeJavaScript(
        `window.scrollBy(0, ${input.action.direction === "down" ? amount : -amount})`
      )
    }

    const page = (await contents.executeJavaScript(ELEMENT_INSPECT_SCRIPT)) as InspectedPage
    this.assertActiveTab(tabId, contents)
    const elements = this.rememberTargets(contents.id, page.elements)
    this.pageFingerprints.set(contents.id, fingerprintPage(page))
    const screenshotBytes =
      input.action.action === "inspect" && input.includeScreenshot
        ? await this.capture(contents)
        : undefined
    this.assertActiveTab(tabId, contents)
    return {
      url: page.url,
      title: page.title,
      pageText: page.pageText,
      elements,
      ...(screenshotBytes ? { screenshotBytes } : {}),
      ...(this.annotations.get(contents.id)?.length
        ? { annotations: [...this.annotations.get(contents.id)!] }
        : {}),
    }
  }

  async dispose(): Promise<void> {
    this.developerInspector.stopDiagnostics("disposed")
    this.guestsByWindow.clear()
    this.tabs.clear()
    this.targets.clear()
    this.annotations.clear()
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
    input: BrowserDeveloperExecuteInput
  ): Promise<BrowserDeveloperResult> {
    const action = input.action

    // Stopping is always allowed so a stuck capture can be cleaned up.
    if (action.action === "stop_diagnostics") {
      const owner = this.developerInspector.summary()?.sessionId ?? this.activeDeveloperRequestSessionId
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
      this.assertDeveloperIdentity(input.sessionId, tabId, contents, scope.scope, epoch, generation, input.cwd)
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
    this.assertDeveloperSnapshot(snapshot, input.cwd)
    const approved = await input.approveDeveloper(
      this.developerReason(scope, action.action)
    )
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
        this.assertDeveloperIdentity(input.sessionId, tabId, contents, scope.scope, epoch, generation, input.cwd)
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
      this.assertDeveloperIdentity(input.sessionId, tabId, contents, scope.scope, epoch, generation, input.cwd)
      return capDeveloperReadResult({ action: "inspect_dom", url: resultUrl, data })
    }

    if (action.action === "inspect_styles") {
      const data = await this.developerInspector.inspectStyles(guest, action.selector)
      this.assertDeveloperIdentity(input.sessionId, tabId, contents, scope.scope, epoch, generation, input.cwd)
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
    snapshot: { tabId: string; webContentsId: number; scope: string; epoch: number; generation: number },
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
      throw new Error("The browser page changed while the tool was waiting. Inspect the page again.")
    }
    const scope = resolveDeveloperScope(current.getURL(), cwd)
    if (!scope || scope.scope !== snapshot.scope) {
      throw new Error("The browser page changed while the tool was waiting. Inspect the page again.")
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
      throw new Error("The browser page changed while the tool was waiting. Inspect the page again.")
    }
    const currentScope = resolveDeveloperScope(contents.getURL(), cwd)
    if (!currentScope || currentScope.scope !== scope) {
      throw new Error("The browser page changed while the tool was waiting. Inspect the page again.")
    }
    if (this.developerInspector.active && !this.developerInspector.ownsSession(sessionId)) {
      throw new Error("Another session is already capturing browser diagnostics.")
    }
  }

  private async openBrowserTab(): Promise<string> {
    if (!this.openTabRequestHandler) throw new Error("Open a page in the desktop browser first.")
    const activeTab = this.activeTabId && this.tabs.has(this.activeTabId) ? this.activeTabId : null
    if (activeTab) return activeTab

    return await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.activeTabWaiters.delete(onReady)
        reject(new Error("Timed out while opening the desktop browser tab."))
      }, 15_000)
      const onReady = (tabId: string): void => {
        clearTimeout(timer)
        resolve(tabId)
      }
      this.activeTabWaiters.add(onReady)
      try {
        this.openTabRequestHandler!()
      } catch (error) {
        clearTimeout(timer)
        this.activeTabWaiters.delete(onReady)
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
    operation: () => Promise<T>
  ): Promise<T> {
    let blockedOrigin: string | null = null
    const guard = (event: Electron.Event, destination: string): void => {
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
    webContentsId: number,
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
      if (target.webContentsId === webContentsId) this.targets.delete(id)
    }
    const snapshotId = ++this.targetSequence
    const result: NonNullable<BrowserObservation["elements"]> = []
    for (const [index, element] of elements.entries()) {
      const id = `e${snapshotId}-${index}`
      this.targets.set(id, {
        webContentsId,
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

  private async applyElementAction(
    contents: WebContents,
    action: Extract<BrowserAction, { action: "click" | "type" }>,
    approve: (question: string) => Promise<boolean>,
    tabId: string
  ): Promise<void> {
    const target = this.targets.get(action.elementId)
    if (!target || target.webContentsId !== contents.id)
      throw new Error("That element ID is stale. Inspect the page again.")
    if (target.requiresConfirmation) {
      const allowed = await approve(
        action.action === "click"
          ? `Confirm clicking “${target.name || target.role}” on ${contents.getURL()}? This action may submit or change data.`
          : `Confirm entering sensitive information in “${target.name || target.role}” on ${contents.getURL()}?`
      )
      if (!allowed) throw new Error("The browser action was not approved.")
    }
    this.assertActiveTab(tabId, contents)
    const selector = JSON.stringify(target.selector)
    const role = JSON.stringify(target.role)
    const name = JSON.stringify(target.name)
    const text = action.action === "type" ? JSON.stringify(action.text.slice(0, 4_000)) : ""
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
      await waitForPageUpdate(contents, this.pageFingerprints.get(contents.id) ?? "")
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

async function waitForPageUpdate(contents: WebContents, before: string): Promise<void> {
  const startedAt = Date.now()
  let lastFingerprint = before
  let changedAt: number | null = null
  while (Date.now() - startedAt < 2_500) {
    await new Promise((resolve) => setTimeout(resolve, 80))
    if (contents.isDestroyed()) return
    if (contents.isLoading()) continue

    let page: InspectedPage
    try {
      page = (await contents.executeJavaScript(ELEMENT_INSPECT_SCRIPT)) as InspectedPage
    } catch {
      // Navigation can replace the execution context between load events.
      continue
    }

    const currentFingerprint = fingerprintPage(page)
    const now = Date.now()
    if (currentFingerprint !== lastFingerprint) {
      lastFingerprint = currentFingerprint
      changedAt = now
    }
    if (changedAt !== null && now - changedAt >= 180) return
    if (changedAt === null && now - startedAt >= 900) return
  }
}

function fingerprintPage(page: InspectedPage): string {
  return JSON.stringify({
    url: page.url,
    title: page.title,
    pageText: page.pageText,
    elements: page.elements.map(({ role, name, href, value }) => ({ role, name, href, value })),
  })
}

export const browserAgentService = new BrowserAgentService()

function capDeveloperReadResult(result: BrowserDeveloperResult): BrowserDeveloperResult {
  const maxBytes = 48 * 1024
  if (result.url.length > 2_048) {
    result.url = result.url.slice(0, 2_048)
    result.truncated = true
  }
  const data = result.data as {
    document?: DeveloperDomView
    node?: DeveloperDomView
    properties?: unknown[]
  }
  while (Buffer.byteLength(JSON.stringify(result), "utf8") > maxBytes) {
    result.truncated = true
    if (data.properties?.length) {
      data.properties.pop()
    } else if (trimDomView(data.document ?? data.node)) {
      continue
    } else {
      result.data = { omitted: "Developer inspection result exceeded the size limit." }
      break
    }
  }
  return result
}

function capDeveloperDiagnosticsResult(result: BrowserDeveloperResult): BrowserDeveloperResult {
  const page = result.data as DeveloperDiagnosticsPage
  while (Buffer.byteLength(JSON.stringify(result), "utf8") > 48 * 1024) {
    result.truncated = true
    page.truncated = true
    if (page.network.length) page.network.pop()
    else if (page.console.length) page.console.pop()
    else {
      result.data = { omitted: "Browser diagnostics result exceeded the size limit." }
      break
    }
  }
  return result
}

function trimDomView(view: DeveloperDomView | undefined): boolean {
  if (!view) return false
  if (view.children?.length) {
    view.children.pop()
    return true
  }
  if (view.attributes) {
    const last = Object.keys(view.attributes).at(-1)
    if (last) {
      delete view.attributes[last]
      return true
    }
  }
  if (view.text) {
    delete view.text
    return true
  }
  return false
}

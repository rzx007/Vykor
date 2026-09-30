import {
  MAX_DOM_NODES,
  MAX_DOM_DEPTH,
  MAX_STYLE_PROPERTIES,
  MAX_STYLE_VALUE,
  asRecord,
  capDiagnosticsPage,
  projectConsoleText,
  readString,
  sanitizeUrl,
  toDomView,
  type RawDomNode,
} from "./browser-developer-projection"
import { resolveDeveloperScope } from "./browser-developer-scope"

export { DEVELOPER_MAX_RESULT_BYTES, sanitizeUrl } from "./browser-developer-projection"
export { describeDeveloperAction, resolveDeveloperScope } from "./browser-developer-scope"

/** Hard limits for one developer inspection. */
export const DEVELOPER_DIAGNOSTICS_TTL_MS = 60_000
export const DEVELOPER_MAX_EVENTS = 200
/** Minimal structural view of an Electron debugger, so tests can substitute a fake. */
export interface DeveloperDebugger {
  isAttached(): boolean
  attach(protocolVersion?: string): void
  detach(): void
  sendCommand(method: string, commandParams?: unknown, debuggerSessionId?: string): Promise<unknown>
  on(event: string, listener: (...args: unknown[]) => void): unknown
  off(event: string, listener: (...args: unknown[]) => void): unknown
}

/** Minimal structural view of an Electron guest WebContents needed for inspection. */
export interface DeveloperGuest {
  id: number
  isDestroyed(): boolean
  getURL(): string
  debugger: DeveloperDebugger
  on(event: string, listener: (...args: unknown[]) => void): unknown
  off(event: string, listener: (...args: unknown[]) => void): unknown
}

export type DeveloperScope =
  | { kind: "http"; scope: string; url: string }
  | { kind: "file"; scope: string; url: string; filePath: string }

export type DeveloperConsoleEntry = {
  type: string
  text: string
  at: number
  source?: string
}

export type DeveloperNetworkEntry = {
  method: string
  url: string
  type: string
  status?: number
  failure?: string
  durationMs?: number
}

export type DeveloperDiagnosticsPage = {
  url: string
  scope: string
  paused: boolean
  console: DeveloperConsoleEntry[]
  network: DeveloperNetworkEntry[]
  truncated: boolean
  expiresAt: number
}

export type DeveloperDomView = {
  nodeType: number
  name: string
  attributes?: Record<string, string>
  text?: string
  childCount?: number
  children?: DeveloperDomView[]
}

type PendingRequest = DeveloperNetworkEntry & { requestId: string; startedAt?: number }

type DeveloperLease = {
  sessionId: string
  tabId: string
  webContentsId: number
  mainFrameId: string
  scope: string
  cwd: string
  navigationEpoch: number
  approvedAt: number
  expiresAt: number
  paused: boolean
  currentUrl: string
  approvedByUs: boolean
  expiryTimer?: ReturnType<typeof setTimeout>
  console: DeveloperConsoleEntry[]
  network: DeveloperNetworkEntry[]
  droppedConsole: number
  droppedNetwork: number
  pendingRequests: Map<string, PendingRequest>
  defaultContextFrames: Map<number, string>
  pendingResume?: { document: boolean; context: boolean }
  pendingEpoch?: number
  pendingUrl?: string
  listeners: {
    message: (...args: unknown[]) => void
    detach: (...args: unknown[]) => void
    destroyed: (...args: unknown[]) => void
  }
  debugger: DeveloperDebugger
  guest: DeveloperGuest
}

export class BrowserDeveloperInspector {
  private lease?: DeveloperLease
  private readonly now: () => number

  constructor(dependencies: { now?: () => number } = {}) {
    this.now = dependencies.now ?? (() => Date.now())
  }

  get active(): boolean {
    return Boolean(this.lease)
  }

  summary(): { sessionId: string; tabId: string; webContentsId: number; expiresAt: number } | null {
    if (!this.lease) return null
    return {
      sessionId: this.lease.sessionId,
      tabId: this.lease.tabId,
      webContentsId: this.lease.webContentsId,
      expiresAt: this.lease.expiresAt,
    }
  }

  ownsSession(sessionId: string): boolean {
    return this.lease?.sessionId === sessionId
  }

  async inspectDom(
    guest: DeveloperGuest,
    selector?: string
  ): Promise<{ selector?: string; found?: boolean; node?: DeveloperDomView; document?: DeveloperDomView }> {
    return await this.withReadConnection(guest, async (debuggerClient) => {
      const document = (await debuggerClient.sendCommand("DOM.getDocument", {
        depth: MAX_DOM_DEPTH + 1,
        pierce: false,
      })) as { root?: RawDomNode }
      const root = document?.root
      if (!root) return { node: undefined }
      if (selector) {
        const { nodeId } = (await debuggerClient.sendCommand("DOM.querySelector", {
          nodeId: root.nodeId,
          selector,
        })) as { nodeId?: number }
        if (!nodeId) return { selector, found: false }
        const { node } = (await debuggerClient.sendCommand("DOM.describeNode", {
          nodeId,
          depth: MAX_DOM_DEPTH + 1,
        })) as { node?: RawDomNode }
        return { selector, found: true, node: toDomView(node, { nodes: MAX_DOM_NODES }, 0) }
      }
      return { document: toDomView(root, { nodes: MAX_DOM_NODES }, 0) }
    })
  }

  async inspectStyles(
    guest: DeveloperGuest,
    selector: string
  ): Promise<{
    selector: string
    found: boolean
    nodeName?: string
    properties?: Array<{ name: string; value: string }>
  }> {
    return await this.withReadConnection(guest, async (debuggerClient) => {
      await debuggerClient.sendCommand("DOM.enable")
      await debuggerClient.sendCommand("CSS.enable")
      const document = (await debuggerClient.sendCommand("DOM.getDocument", {
        depth: 1,
        pierce: false,
      })) as { root?: RawDomNode }
      const root = document?.root
      if (!root) return { selector, found: false }
      const { nodeId } = (await debuggerClient.sendCommand("DOM.querySelector", {
        nodeId: root.nodeId,
        selector,
      })) as { nodeId?: number }
      if (!nodeId) return { selector, found: false }
      const described = (await debuggerClient.sendCommand("DOM.describeNode", {
        nodeId,
        depth: 1,
      })) as { node?: RawDomNode }
      const computed = (await debuggerClient.sendCommand("CSS.getComputedStyleForNode", {
        nodeId,
      })) as { computedStyle?: Array<{ name?: unknown; value?: unknown }> }
      const properties = (Array.isArray(computed?.computedStyle) ? computed.computedStyle : [])
        .slice(0, MAX_STYLE_PROPERTIES)
        .map((property) => ({
          name: String(property?.name ?? "").slice(0, 80),
          value: String(property?.value ?? "").slice(0, MAX_STYLE_VALUE),
        }))
      const rawName = described?.node?.nodeName
      return {
        selector,
        found: true,
        ...(typeof rawName === "string" ? { nodeName: rawName.toLowerCase().slice(0, 80) } : {}),
        properties,
      }
    })
  }

  async startDiagnostics(
    guest: DeveloperGuest,
    target: {
      sessionId: string
      tabId: string
      scope: string
      cwd: string
      url: string
      navigationEpoch: number
    }
  ): Promise<{ expiresAt: number }> {
    if (this.lease && this.lease.sessionId !== target.sessionId) {
      throw new Error("Another session is already capturing browser diagnostics.")
    }
    this.stopDiagnostics("restart")

    const debuggerClient = guest.debugger
    if (!debuggerClient) throw new Error("This browser tab cannot be inspected.")
    if (debuggerClient.isAttached()) {
      throw new Error("The browser page is already being debugged by another owner.")
    }

    const approvedAt = this.now()
    const lease: DeveloperLease = {
      sessionId: target.sessionId,
      tabId: target.tabId,
      webContentsId: guest.id,
      mainFrameId: "",
      scope: target.scope,
      cwd: target.cwd,
      navigationEpoch: target.navigationEpoch,
      approvedAt,
      expiresAt: approvedAt + DEVELOPER_DIAGNOSTICS_TTL_MS,
      paused: false,
      currentUrl: target.url,
      approvedByUs: false,
      console: [],
      network: [],
      droppedConsole: 0,
      droppedNetwork: 0,
      pendingRequests: new Map(),
      defaultContextFrames: new Map(),
      listeners: {
        message: (...args: unknown[]) => {
          const method = typeof args[1] === "string" ? args[1] : ""
          const debuggerSessionId = typeof args[3] === "string" ? args[3] : ""
          this.onDebuggerMessage(lease, method, args[2], debuggerSessionId)
        },
        detach: () => this.stopDiagnostics("debugger detached"),
        destroyed: () => this.stopDiagnostics("guest destroyed"),
      },
      debugger: debuggerClient,
      guest,
    }
    this.lease = lease
    lease.expiryTimer = setTimeout(() => {
      if (this.lease === lease) this.stopDiagnostics("expired")
    }, DEVELOPER_DIAGNOSTICS_TTL_MS)
    lease.expiryTimer.unref?.()
    debuggerClient.on("message", lease.listeners.message)
    debuggerClient.on("detach", lease.listeners.detach)
    guest.on("destroyed", lease.listeners.destroyed)

    try {
      debuggerClient.attach()
      lease.approvedByUs = true
      await debuggerClient.sendCommand("Page.enable")
      const tree = (await debuggerClient.sendCommand("Page.getFrameTree")) as {
        frameTree?: { frame?: { id?: unknown } }
      }
      const mainFrameId = tree?.frameTree?.frame?.id
      if (typeof mainFrameId !== "string" || !mainFrameId) {
        throw new Error("The browser page has no main frame to inspect.")
      }
      lease.mainFrameId = mainFrameId
      await debuggerClient.sendCommand("Runtime.enable")
      await debuggerClient.sendCommand("Network.enable")
    } catch (error) {
      this.stopDiagnostics("attach failed")
      throw error instanceof Error ? error : new Error(String(error))
    }
    return { expiresAt: lease.expiresAt }
  }

  handleNavigationStart(webContentsId: number, url: string | undefined, epoch: number): void {
    const lease = this.lease
    if (!lease || lease.webContentsId !== webContentsId) return
    const nextScope = typeof url === "string" ? resolveDeveloperScope(url, lease.cwd) : null
    if (!nextScope || nextScope.scope !== lease.scope) {
      this.stopDiagnostics("cross-origin navigation")
      return
    }
    lease.paused = true
    lease.pendingEpoch = epoch
    if (typeof url === "string") lease.pendingUrl = url
    lease.pendingResume = { document: false, context: false }
    lease.console = []
    lease.network = []
    lease.droppedConsole = 0
    lease.droppedNetwork = 0
    lease.pendingRequests.clear()
    lease.defaultContextFrames.clear()
  }

  readDiagnostics(
    guest: DeveloperGuest,
    input: { sessionId: string; scope: string; navigationEpoch: number }
  ): DeveloperDiagnosticsPage {
    const lease = this.lease
    if (!lease) throw new Error("No browser diagnostics capture is active.")
    if (lease.sessionId !== input.sessionId) {
      throw new Error("This session does not own the active browser diagnostics capture.")
    }
    if (lease.webContentsId !== guest.id || lease.scope !== input.scope) {
      throw new Error("The inspected browser page changed while reading diagnostics.")
    }
    if (this.now() >= lease.expiresAt) {
      this.stopDiagnostics("expired")
      throw new Error("The browser diagnostics capture expired.")
    }
    if (!lease.paused && lease.navigationEpoch !== input.navigationEpoch) {
      throw new Error("The inspected browser page changed while reading diagnostics.")
    }
    const page: DeveloperDiagnosticsPage = {
      url: sanitizeUrl(lease.currentUrl),
      scope: lease.scope,
      paused: lease.paused,
      console: lease.console.map((entry) => ({ ...entry })),
      network: lease.network.map((entry) => ({ ...entry })),
      truncated: lease.droppedConsole > 0 || lease.droppedNetwork > 0,
      expiresAt: lease.expiresAt,
    }
    return capDiagnosticsPage(page)
  }

  stopDiagnostics(reason?: string): boolean {
    void reason
    const lease = this.lease
    if (!lease) return false
    this.lease = undefined
    if (lease.expiryTimer) clearTimeout(lease.expiryTimer)
    try {
      lease.debugger.off("message", lease.listeners.message)
      lease.debugger.off("detach", lease.listeners.detach)
    } catch {
      // The debugger or webContents may already be gone; cleanup must still finish.
    }
    try {
      lease.guest.off("destroyed", lease.listeners.destroyed)
    } catch {
      // Ignore a destroyed guest.
    }
    lease.console = []
    lease.network = []
    lease.pendingRequests.clear()
    lease.defaultContextFrames.clear()
    if (lease.approvedByUs) {
      try {
        lease.debugger.detach()
      } catch {
        // Already detached.
      }
    }
    return true
  }

  private async withReadConnection<T>(
    guest: DeveloperGuest,
    operation: (client: DeveloperDebugger) => Promise<T>
  ): Promise<T> {
    const debuggerClient = guest.debugger
    if (!debuggerClient) throw new Error("This browser tab cannot be inspected.")
    const leaseOwnsDebugger =
      this.lease?.webContentsId === guest.id && this.lease.approvedByUs
    if (!leaseOwnsDebugger) {
      if (debuggerClient.isAttached()) {
        throw new Error("The browser page is already being debugged by another owner.")
      }
      try {
        debuggerClient.attach()
      } catch (error) {
        throw error instanceof Error ? error : new Error("Could not attach to the browser page.")
      }
    }
    try {
      return await operation(debuggerClient)
    } finally {
      if (!leaseOwnsDebugger) {
        try {
          debuggerClient.detach()
        } catch {
          // Already detached.
        }
      }
    }
  }

  private onDebuggerMessage(
    lease: DeveloperLease,
    method: string,
    params: unknown,
    debuggerSessionId: string
  ): void {
    if (debuggerSessionId) return
    if (this.lease !== lease) return
    if (this.now() >= lease.expiresAt) {
      this.stopDiagnostics("expired")
      return
    }
    const data = asRecord(params)
    if (method === "Runtime.executionContextCreated") {
      this.onExecutionContextCreated(lease, data)
      return
    }
    if (method === "Page.frameNavigated") {
      this.onFrameNavigated(lease, data)
      return
    }
    if (lease.paused) return

    if (method === "Runtime.consoleAPICalled") {
      this.onConsole(lease, data)
      return
    }
    if (method === "Network.requestWillBeSent") {
      this.onRequest(lease, data)
      return
    }
    const requestId = readString(data?.requestId)
    if (!requestId) return
    if (method === "Network.responseReceived") {
      const pending = lease.pendingRequests.get(requestId)
      if (!pending) return
      const status = asRecord(data?.response)?.status
      if (typeof status === "number") pending.status = status
      const type = readString(data?.type)
      if (type) pending.type = type.slice(0, 32)
      return
    }
    if (method === "Network.loadingFinished" || method === "Network.loadingFailed") {
      const pending = lease.pendingRequests.get(requestId)
      if (!pending) return
      if (method === "Network.loadingFailed") {
        const failure = readString(data?.errorText) ?? readString(data?.blockedReason) ?? "failed"
        pending.failure = failure.slice(0, 120)
      }
      const timestamp = data?.timestamp
      if (typeof timestamp === "number" && pending.startedAt !== undefined) {
        pending.durationMs = Math.max(0, Math.round((timestamp - pending.startedAt) * 1000))
      }
      lease.pendingRequests.delete(pending.requestId)
      if (lease.network.length >= DEVELOPER_MAX_EVENTS) {
        lease.network.shift()
        lease.droppedNetwork += 1
      }
      lease.network.push({
        method: pending.method,
        url: pending.url,
        type: pending.type,
        ...(pending.status !== undefined ? { status: pending.status } : {}),
        ...(pending.failure !== undefined ? { failure: pending.failure } : {}),
        ...(pending.durationMs !== undefined ? { durationMs: pending.durationMs } : {}),
      })
    }
  }

  private onExecutionContextCreated(
    lease: DeveloperLease,
    data: Record<string, unknown> | undefined
  ): void {
    const context = asRecord(data?.context)
    if (!context || typeof context.id !== "number") return
    const auxData = asRecord(context.auxData)
    if (!auxData || auxData.isDefault !== true) return
    if (auxData.frameId !== lease.mainFrameId) return
    lease.defaultContextFrames.set(context.id, String(auxData.frameId))
    if (lease.pendingResume) {
      lease.pendingResume.context = true
      this.maybeResume(lease)
    }
  }

  private onFrameNavigated(
    lease: DeveloperLease,
    data: Record<string, unknown> | undefined
  ): void {
    const frame = asRecord(data?.frame)
    if (!frame || typeof frame.id !== "string") return
    // Only main-frame navigation has no parent; subframes must never resume capture.
    if (frame.parentId) return
    const finalUrl = readString(frame.url)
    const finalScope = finalUrl ? resolveDeveloperScope(finalUrl, lease.cwd) : null
    if (!finalScope || finalScope.scope !== lease.scope) {
      this.stopDiagnostics("cross-origin main frame")
      return
    }
    if (!lease.pendingResume && finalUrl !== lease.currentUrl) {
      this.stopDiagnostics("untracked main-frame navigation")
      return
    }
    lease.mainFrameId = frame.id
    if (lease.pendingResume) {
      lease.pendingUrl = finalUrl
      lease.pendingResume.document = true
      this.maybeResume(lease)
    }
  }

  private maybeResume(lease: DeveloperLease): void {
    if (!lease.pendingResume || !lease.pendingResume.document || !lease.pendingResume.context) {
      return
    }
    lease.pendingResume = undefined
    if (lease.pendingEpoch !== undefined) lease.navigationEpoch = lease.pendingEpoch
    if (lease.pendingUrl !== undefined) lease.currentUrl = lease.pendingUrl
    lease.pendingEpoch = undefined
    lease.pendingUrl = undefined
    lease.paused = false
  }

  private onConsole(lease: DeveloperLease, data: Record<string, unknown> | undefined): void {
    const executionContextId = data?.executionContextId
    const frameId =
      typeof executionContextId === "number"
        ? lease.defaultContextFrames.get(executionContextId)
        : undefined
    if (frameId !== lease.mainFrameId) return
    const at = typeof data?.timestamp === "number" ? data.timestamp : this.now()
    // Runtime.enable can replay messages that predate approval; those are dropped.
    if (at < lease.approvedAt) return
    const text = projectConsoleText(data?.args)
    if (!text) return
    const entry: DeveloperConsoleEntry = {
      type: (readString(data?.type) ?? "log").slice(0, 32),
      text,
      at: Math.round(at),
    }
    const callFrames = asRecord(data?.stackTrace)?.callFrames
    const source = Array.isArray(callFrames) ? asRecord(callFrames[0])?.url : undefined
    if (typeof source === "string" && source) {
      const sanitized = sanitizeUrl(source)
      if (sanitized) entry.source = sanitized
    }
    if (lease.console.length >= DEVELOPER_MAX_EVENTS) {
      lease.console.shift()
      lease.droppedConsole += 1
    }
    lease.console.push(entry)
  }

  private onRequest(lease: DeveloperLease, data: Record<string, unknown> | undefined): void {
    // Only requests initiated by the main frame; subframe and unrelated requests are dropped.
    if (data?.frameId !== lease.mainFrameId) return
    const requestId = data?.requestId
    if (typeof requestId !== "string") return
    const request = asRecord(data?.request) ?? {}
    const entry: PendingRequest = {
      requestId,
      method: (readString(request.method) ?? "GET").slice(0, 16),
      url: sanitizeUrl(request.url),
      type: (readString(data?.type) ?? "Other").slice(0, 32),
      ...(typeof data?.timestamp === "number" ? { startedAt: data.timestamp } : {}),
    }
    if (!lease.pendingRequests.has(requestId) && lease.pendingRequests.size >= DEVELOPER_MAX_EVENTS) {
      const oldest = lease.pendingRequests.keys().next().value
      if (oldest !== undefined) lease.pendingRequests.delete(oldest)
      lease.droppedNetwork += 1
    }
    lease.pendingRequests.set(requestId, entry)
  }
}

import {
  PLUGIN_UI_BRIDGE_LIMITS as limits,
  PluginUiBridgeError,
  decodePluginUiBridgeMessage,
  encodePluginUiBridgeMessage,
  parsePluginUiBridgeRequest,
  parsePluginUiBridgeSnapshot,
  type PluginUiBridgeRequest,
  type PluginUiActionReceipt,
  type PluginUiViewSnapshot,
} from "@vykor/client"

type Result = PluginUiViewSnapshot | PluginUiActionReceipt | null
type Handler = (params: Record<string, unknown>, signal: AbortSignal) => Promise<Result>
interface Options {
  iframe: HTMLIFrameElement
  mountId: string
  snapshot: PluginUiViewSnapshot
  isActive(): boolean
  handlers: Record<PluginUiBridgeRequest["method"], Handler>
  onError(code: string): void
}
/** Only the bound frame can receive a port; window messages never execute actions. */
export function createPluginUiBridge(options: Options) {
  const host = options.iframe.ownerDocument.defaultView!
  let current = parsePluginUiBridgeSnapshot(options.snapshot)
  let port: MessagePort | undefined
  let closed = false
  let confirming = false
  const seen = new Set<string>()
  const pending = new Map<string, AbortController>()
  const arrivals: number[] = []
  const active = () => !closed && options.isActive()
  const send = (message: unknown) => {
    if (active() && port) port.postMessage(encodePluginUiBridgeMessage(message))
  }
  const respondError = (id: string, code: string) =>
    send({
      version: 1,
      mountId: options.mountId,
      id,
      error: { code, message: code },
    })
  const dispose = () => {
    if (closed) return
    if (port)
      port.postMessage(
        encodePluginUiBridgeMessage({ version: 1, mountId: options.mountId, type: "dispose" })
      )
    closed = true
    clearTimeout(initialization)
    host.removeEventListener("message", ready)
    for (const controller of pending.values()) controller.abort()
    pending.clear()
    port?.close()
  }
  const pushSnapshot = (value: PluginUiViewSnapshot) => {
    const next = parsePluginUiBridgeSnapshot(value)
    if (!active() || next.instanceId !== current.instanceId || next.revision < current.revision)
      return
    current = next
    send({ version: 1, mountId: options.mountId, type: "snapshot", snapshot: current })
  }
  async function receive(event: MessageEvent) {
    if (!active()) return
    const now = Date.now()
    while (arrivals[0] !== undefined && arrivals[0] <= now - limits.rateWindowMs) arrivals.shift()
    const limited = arrivals.length >= limits.requestsPerMinute
    if (!limited) arrivals.push(now)
    let message: PluginUiBridgeRequest
    let decoded: unknown
    try {
      decoded = decodePluginUiBridgeMessage(event.data)
      message = parsePluginUiBridgeRequest(decoded)
    } catch (error) {
      const header = decoded as Partial<PluginUiBridgeRequest> | undefined
      if (
        header?.mountId === options.mountId &&
        typeof header.id === "string" &&
        [...header.id].length <= 80
      )
        respondError(
          header.id,
          limited
            ? "plugin_ui_rate_limited"
            : error instanceof PluginUiBridgeError
              ? error.code
              : "plugin_ui_invalid_message"
        )
      return
    }
    if (limited) {
      respondError(message.id, "plugin_ui_rate_limited")
      return
    }
    if (message.mountId !== options.mountId) {
      respondError(message.id, "plugin_ui_mount_closed")
      return
    }
    if (seen.has(message.id)) {
      respondError(message.id, "plugin_ui_duplicate_request")
      return
    }
    seen.add(message.id)
    if (pending.size >= limits.pendingRequests) {
      respondError(message.id, "plugin_ui_too_many_requests")
      return
    }
    const confirmation = message.method === "requestAction" || message.method === "dismiss"
    if (confirmation && confirming) {
      respondError(message.id, "plugin_ui_confirmation_pending")
      return
    }
    if (message.method === "requestAction") {
      if (current.readOnly || current.status !== "open") {
        respondError(message.id, "plugin_ui_read_only")
        return
      }
      if (!current.actions.some((action) => action.id === message.params.actionId)) {
        respondError(message.id, "plugin_ui_invalid_action")
        return
      }
      if (message.params.expectedRevision !== current.revision) {
        respondError(message.id, "plugin_ui_revision_conflict")
        return
      }
    }
    if (message.method === "dismiss" && (current.status !== "open" || current.activeAction)) {
      respondError(message.id, "plugin_ui_read_only")
      return
    }
    if (
      (message.method === "resize" || message.method === "openSidebar") &&
      current.surface !== "tool-result"
    ) {
      respondError(message.id, "plugin_ui_surface_not_supported")
      return
    }
    const controller = new AbortController()
    pending.set(message.id, controller)
    if (confirmation) confirming = true
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      const result = await Promise.race([
        options.handlers[message.method](message.params, controller.signal),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => {
              reject(new PluginUiBridgeError("plugin_ui_timeout"))
              controller.abort()
            },
            confirmation ? limits.confirmedRequestMs : limits.requestMs
          )
          controller.signal.addEventListener(
            "abort",
            () => reject(new PluginUiBridgeError("plugin_ui_mount_closed")),
            { once: true }
          )
        }),
      ])
      if (active() && !controller.signal.aborted) {
        if (message.method === "getSnapshot") pushSnapshot(result as PluginUiViewSnapshot)
        send({ version: 1, mountId: options.mountId, id: message.id, result })
      }
    } catch (error) {
      if (active())
        respondError(
          message.id,
          error instanceof PluginUiBridgeError ? error.code : "plugin_ui_unavailable"
        )
    } finally {
      clearTimeout(timeout)
      pending.delete(message.id)
      if (confirmation) confirming = false
    }
  }
  function ready(event: MessageEvent) {
    const value = event.data
    if (
      !active() ||
      port ||
      event.source !== options.iframe.contentWindow ||
      !value ||
      value.version !== 1 ||
      value.type !== "plugin-ui-ready" ||
      Object.keys(value).length !== 2
    )
      return
    const channel = new MessageChannel()
    port = channel.port1
    port.onmessage = (event) => {
      void receive(event)
    }
    port.start()
    host.removeEventListener("message", ready)
    clearTimeout(initialization)
    options.iframe.contentWindow!.postMessage(
      { version: 1, type: "plugin-ui-init", mountId: options.mountId },
      "*",
      [channel.port2]
    )
    pushSnapshot(current)
  }
  const initialization = setTimeout(() => {
    options.onError("plugin_ui_timeout")
    dispose()
  }, limits.initializationMs)
  host.addEventListener("message", ready)
  return { pushSnapshot, dispose }
}

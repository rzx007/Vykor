import { App, PostMessageTransport } from "@modelcontextprotocol/ext-apps"
import { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge"
import { PluginAppPageManager, canUseAppSidebar } from "../../src/renderer/src/components/desktop/shell/plugin-apps/page-manager"
import { PluginAppTransport } from "../../src/renderer/src/components/desktop/shell/plugin-apps/transport"
import type { PluginAppMount } from "../../src/shared/plugin-app-types"
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js"
import { parseMcpCallResultData } from "../../../../packages/protocol/src/mcp-apps"

interface Probe {
  connected?: boolean
  input?: unknown
  result?: unknown
  cancelled?: string
  requestRejected?: boolean
  requestAborted?: boolean
  initialized?: boolean
  error?: string
}
declare global {
  interface Window {
    mcpSdkProbe: Probe
    runMcpSdkFixture: (url: string, result: unknown) => Promise<void>
    disposeMcpSdkFixture?: () => Promise<void>
  }
}

window.mcpSdkProbe = {}
if (document.documentElement.dataset.mcpMode) {
  const mode = document.documentElement.dataset.mcpMode
  const modes = mode === "omitted" ? {} : { availableDisplayModes: mode === "inline" ? ["inline" as const] : ["inline" as const, "fullscreen" as const] }
  const app = new App({ name: "Mode fixture", version: "1" }, modes, { autoResize: false })
  Object.assign(window, { modeApp: app, modeHandshakes: 0 })
  document.body.innerHTML = '<input id="draft" value="retained draft">'
  void app.connect(new PostMessageTransport(window.parent, window.parent)).then(() => { Object.assign(window, { modeHandshakes: 1 }) })
} else if (document.documentElement.dataset.mcpSdk === "app") {
  const app = new App({ name: "Vykor official SDK fixture", version: "1.0.0" }, {}, { autoResize: false })
  const abort = new AbortController()
  const report = () => window.parent.postMessage({ type: "mcp-sdk-probe", probe: window.mcpSdkProbe }, "*")
  window.addEventListener("message", event => {
    if (event.source === window.parent && event.data === "abort-sdk-request") abort.abort(new Error("fixture cancelled"))
  })
  app.ontoolinput = params => { window.mcpSdkProbe.input = params.arguments; report() }
  app.ontoolcancelled = params => { window.mcpSdkProbe.cancelled = params.reason; report() }
  app.ontoolresult = params => {
    window.mcpSdkProbe.result = params
    report()
    void app.callServerTool({ name: "cancel-check", arguments: {} }, { signal: abort.signal }).then(
      () => { window.mcpSdkProbe.error = "Cancelled request unexpectedly completed"; report() },
      () => { window.mcpSdkProbe.requestRejected = true; report() },
    )
  }
  void app.connect(new PostMessageTransport(window.parent, window.parent)).then(
    () => { window.mcpSdkProbe.connected = true; report() },
    error => { window.mcpSdkProbe.error = String(error); report() },
  )
} else {
  Object.assign(window, { runMcpModeFixture: async (url: string) => {
    const mounted: PluginAppMount = { mountId: "mode", url, state: { online: true, source: { sessionId: "mode", appId: "mode" },
      availability: { canReadResource: true, canInvokeTools: false, canMessage: false }, app: { id: "mode", sessionId: "mode", pluginId: "fixture",
        pluginVersion: "1", pluginDigest: "fixture", definitionDigest: "fixture", backendId: "fixture", backendKind: "native-tools",
        resourceUri: "ui://fixture/mode", origin: { kind: "tool-result", sourcePartId: "part" }, logicalKey: "mode", status: "open", controlRevision: 0, createdAt: 1, updatedAt: 1 } } }
    const manager = new PluginAppPageManager({ mount: async () => mounted, release: async () => {} } as never, async () => false)
    const page = await manager.mount(mounted.state.source, "Modes")
    let handshakes = 0
    const onModes = page.onModes
    page.onModes = modes => { handshakes++; onModes?.(modes) }
    const container = document.createElement("div"), frame = document.createElement("iframe")
    container.style.position = "fixed"; frame.sandbox.add("allow-scripts"); container.append(frame); document.body.append(container)
    page.element = container
    const peer = frame.contentWindow, inline = Symbol(), sidebar = Symbol()
    page.transport = new PluginAppTransport(frame, page.controller, page)
    manager.place(page.id, new DOMRect(10, 20, 300, 200), inline)
    Object.assign(window, {
      modePlace: (where: string) => {
        if (where === "sidebar") manager.place(page.id, new DOMRect(400, 20, 200, 600), sidebar, "fullscreen")
        else if (where === "hidden") { manager.place(page.id, null, sidebar, "fullscreen"); manager.place(page.id, null, inline) }
        else { manager.releaseAnchor(page.id, sidebar); manager.place(page.id, new DOMRect(10, 20, 300, 200), inline) }
      },
      modeState: () => ({ eligible: canUseAppSidebar(page), modes: page.modes, visibility: container.style.visibility, mode: container.dataset.displayMode,
        handshakes, sameWindow: frame.contentWindow === peer, attached: frame.parentElement === container, left: container.style.left, width: container.style.width }),
      disposeMcpModeFixture: async () => { await manager.dispose(); container.remove() },
    })
    await page.transport.connect()
  } })
  window.runMcpSdkFixture = async (url, raw) => {
    // A bounded JSON boundary plus the official runtime schema, without cross-version casts.
    const bounded = parseMcpCallResultData(raw)
    const result = CallToolResultSchema.parse(bounded)
    const frame = document.createElement("iframe")
    frame.sandbox.add("allow-scripts")
    frame.allow = "camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'; fullscreen 'none'"
    document.body.append(frame)
    const peer = frame.contentWindow!
    const bridge = new AppBridge(null, { name: "Vykor fixture host", version: "1.0.0" }, { serverTools: {} })
    bridge.onerror = error => { window.mcpSdkProbe.error = String(error) }
    const receiveProbe = (event: MessageEvent) => {
      if (event.source !== peer || event.data?.type !== "mcp-sdk-probe") return
      Object.assign(window.mcpSdkProbe, event.data.probe)
    }
    window.addEventListener("message", receiveProbe)
    window.disposeMcpSdkFixture = async () => {
      window.removeEventListener("message", receiveProbe)
      await bridge.close()
      frame.remove()
    }
    bridge.oncalltool = async (params, extra) => {
      if (params.name !== "cancel-check") throw new Error("Unexpected fixture request")
      return await new Promise<never>((_resolve, reject) => {
        const cancelled = () => {
          window.mcpSdkProbe.requestAborted = true
          void bridge.sendToolCancelled({ reason: "fixture cancellation" })
          reject(new Error("fixture cancellation"))
        }
        if (extra.signal.aborted) cancelled()
        else extra.signal.addEventListener("abort", cancelled, { once: true })
        peer.postMessage("abort-sdk-request", "*")
      })
    }
    bridge.oninitialized = () => {
      window.mcpSdkProbe.initialized = true
      void (async () => {
        await bridge.sendToolInput({ arguments: { fixture: "initial input" } })
        await bridge.sendToolResult(result)
      })().catch(error => { window.mcpSdkProbe.error = String(error) })
    }
    await bridge.connect(new PostMessageTransport(peer, peer))
    frame.src = url
  }
}

import { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge"
import { PostMessageTransport, type McpUiHostContext } from "@modelcontextprotocol/ext-apps"
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js"
import { parseMcpCallResultData } from "@rzx/client"
import type { PluginAppController } from "./controller"
import type { AppDisplayMode, ResidentAppPage } from "./page-manager"
import { installAppHandlers } from "./handlers"
import { attachResourceFeed } from "./plugin-app-resource-feed"
export class PluginAppTransport {
  readonly bridge: AppBridge
  private initialized = false
  private closed = false
  private initialSent = false
  private readonly deliveredParts = new Set<string>()
  private readonly results: Array<{ arguments: Record<string, unknown>; result?: unknown }> = []
  private flushing = false
  private readonly stopResourceFeed: () => void
  private resourcesDirty = false
  private displayMode: "inline" | "fullscreen" = "inline"
  private modes: AppDisplayMode[] = ["inline"]
  constructor(readonly frame: HTMLIFrameElement, readonly controller: PluginAppController, private readonly placement?: Pick<ResidentAppPage, "onModes" | "requestDisplayMode">) {
    this.bridge = new AppBridge(null, { name: "Vykor Desktop", version: "1.0.0" }, {
      ...(typeof controller.api.prepareMessage === "function" && typeof controller.api.submitMessage === "function" && controller.state.availability.canMessage ? { message: { text: {} } } : {}),
      ...(typeof controller.api.updateModelContext === "function" ? { updateModelContext: { text: {}, structuredContent: {} } } : {}),
      ...(controller.state.availability.canInvokeTools ? { serverTools: {} } : {}),
      ...(controller.state.availability.canReadResource ? { serverResources: {} } : {}),
    }, { hostContext: { ...readHostContext(), availableDisplayModes: ["inline"] } })
    installAppHandlers(this.bridge, controller)
    this.bridge.onrequestdisplaymode = async ({ mode }) => {
      controller.assertInteraction()
      if ((mode !== "inline" && mode !== "fullscreen") || !this.modes.includes(mode) || !this.placement?.requestDisplayMode)
        throw new Error("plugin_app_display_mode_unavailable")
      this.placement.requestDisplayMode(mode)
      return { mode: this.displayMode }
    }
    this.stopResourceFeed = attachResourceFeed(controller.api, controller.mounted.mountId, () => {
      this.resourcesDirty = true; this.flushResources()
    })
    this.bridge.oninitialized = () => {
      if (this.closed) return
      // SDK 1.1.2 publicly negotiates these capabilities; omission grants inline only.
      this.modes = (this.bridge.getAppCapabilities()?.availableDisplayModes ?? ["inline"])
        .filter((mode): mode is AppDisplayMode => mode === "inline" || mode === "fullscreen")
      this.initialized = true
      this.placement?.onModes?.(this.modes)
      this.updateContext(); this.flushResources(); void this.flush().catch(() => {})
    }
  }
  private flushResources(): void {
    if (this.closed || !this.initialized || !this.resourcesDirty) return
    this.resourcesDirty = false
    void this.bridge.sendResourceListChanged().catch(() => { this.resourcesDirty = true })
  }
  async connect(): Promise<void> {
    const peer = this.frame.contentWindow
    if (!peer) throw new Error("plugin_app_frame_unavailable")
    await this.bridge.connect(new PostMessageTransport(peer, peer))
    if (!this.closed) this.frame.src = this.controller.mounted.url
  }
  /** Task 9 passes authorized initial/model results here. A page's own calls never use this path. */
  queueInitial(input: { arguments: Record<string, unknown>; result?: unknown }): void {
    if (this.initialSent) return
    this.initialSent = true
    this.results.push(input)
    void this.flush().catch(() => {})
  }
  queueToolResult(input: { sourcePartId: string; arguments: Record<string, unknown>; result: unknown }): void {
    if (this.deliveredParts.has(input.sourcePartId) || this.closed) return
    this.deliveredParts.add(input.sourcePartId)
    this.results.push(input)
    void this.flush().catch(() => {})
  }
  private async flush(): Promise<void> {
    if (!this.initialized || this.closed || this.flushing) return
    this.flushing = true
    try {
      while (!this.closed && this.results.length) {
        const input = this.results.shift()!
        await this.bridge.sendToolInput({ arguments: input.arguments })
        if (!this.closed && input.result !== undefined) await this.bridge.sendToolResult(CallToolResultSchema.parse(parseMcpCallResultData(input.result)))
      }
    } finally { this.flushing = false }
  }
  setDisplayMode(mode: AppDisplayMode): void {
    if (!this.initialized || !this.modes.includes(mode)) throw new Error("plugin_app_display_mode_unavailable")
    if (mode === this.displayMode) return
    this.displayMode = mode; this.updateContext()
  }
  updateContext(context: McpUiHostContext = readHostContext()): void { if (!this.closed) this.bridge.setHostContext({ ...context, displayMode: this.displayMode, availableDisplayModes: this.modes }) }
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.results.length = 0
    this.stopResourceFeed()
    if (this.initialized) await this.bridge.teardownResource({}, { timeout: 500 }).catch(() => {})
    await this.bridge.close()
  }
}
export function readHostContext(): McpUiHostContext {
  const style = getComputedStyle(document.documentElement)
  // SDK 1.1.2 publicly requires every style key, with undefined for values not supplied.
  const variables: NonNullable<NonNullable<McpUiHostContext["styles"]>["variables"]> = {
    "--color-background-primary": undefined, "--color-background-secondary": undefined, "--color-background-tertiary": undefined,
    "--color-background-inverse": undefined, "--color-background-ghost": undefined, "--color-background-info": undefined,
    "--color-background-danger": undefined, "--color-background-success": undefined, "--color-background-warning": undefined,
    "--color-background-disabled": undefined, "--color-text-primary": undefined, "--color-text-secondary": undefined,
    "--color-text-tertiary": undefined, "--color-text-inverse": undefined, "--color-text-ghost": undefined,
    "--color-text-info": undefined, "--color-text-danger": undefined, "--color-text-success": undefined,
    "--color-text-warning": undefined, "--color-text-disabled": undefined, "--color-border-primary": undefined,
    "--color-border-secondary": undefined, "--color-border-tertiary": undefined, "--color-border-inverse": undefined,
    "--color-border-ghost": undefined, "--color-border-info": undefined, "--color-border-danger": undefined,
    "--color-border-success": undefined, "--color-border-warning": undefined, "--color-border-disabled": undefined,
    "--color-ring-primary": undefined, "--color-ring-secondary": undefined, "--color-ring-inverse": undefined,
    "--color-ring-info": undefined, "--color-ring-danger": undefined, "--color-ring-success": undefined,
    "--color-ring-warning": undefined, "--font-sans": undefined, "--font-mono": undefined,
    "--font-weight-normal": undefined, "--font-weight-medium": undefined, "--font-weight-semibold": undefined,
    "--font-weight-bold": undefined, "--font-text-xs-size": undefined, "--font-text-sm-size": undefined,
    "--font-text-md-size": undefined, "--font-text-lg-size": undefined, "--font-heading-xs-size": undefined,
    "--font-heading-sm-size": undefined, "--font-heading-md-size": undefined, "--font-heading-lg-size": undefined,
    "--font-heading-xl-size": undefined, "--font-heading-2xl-size": undefined, "--font-heading-3xl-size": undefined,
    "--font-text-xs-line-height": undefined, "--font-text-sm-line-height": undefined, "--font-text-md-line-height": undefined,
    "--font-text-lg-line-height": undefined, "--font-heading-xs-line-height": undefined, "--font-heading-sm-line-height": undefined,
    "--font-heading-md-line-height": undefined, "--font-heading-lg-line-height": undefined, "--font-heading-xl-line-height": undefined,
    "--font-heading-2xl-line-height": undefined, "--font-heading-3xl-line-height": undefined, "--border-radius-xs": undefined,
    "--border-radius-sm": undefined, "--border-radius-md": undefined, "--border-radius-lg": undefined,
    "--border-radius-xl": undefined, "--border-radius-full": undefined, "--border-width-regular": undefined,
    "--shadow-hairline": undefined, "--shadow-sm": undefined, "--shadow-md": undefined,
    "--shadow-lg": undefined,
  }
  for (const [target, source] of [
    ["--color-background-primary", "--background"], ["--color-background-secondary", "--accent"],
    ["--color-background-inverse", "--primary"], ["--color-text-primary", "--foreground"],
    ["--color-text-secondary", "--muted-foreground"], ["--color-text-inverse", "--primary-foreground"],
    ["--color-text-danger", "--destructive"], ["--color-border-primary", "--border"],
    ["--color-ring-primary", "--ring"], ["--font-sans", "--font-sans"],
    ["--font-mono", "--font-mono"],
  ] as const) {
    const value = style.getPropertyValue(source).trim()
    if (value) variables[target] = value
  }
  return { theme: document.documentElement.classList.contains("dark") ? "dark" : "light", locale: navigator.language,
    styles: { variables }, platform: "desktop", displayMode: "inline", availableDisplayModes: ["inline", "fullscreen"], timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }
}

import type { DesktopPluginAppsAPI, PluginAppHostState, PluginAppMount, PluginAppConfirmation } from "@shared/plugin-app-types"
import { CallToolResultSchema, ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js"
import { pluginAppModelContexts } from "./plugin-app-model-context"
import { parseMcpCallResultData } from "@vykor/client"
export interface AppConfirmationSource { title: string; pluginId: string; sessionId: string; description?: string }
export type AppConfirmation = (request: PluginAppConfirmation, signal: AbortSignal, source?: AppConfirmationSource) => Promise<boolean>
const hiddenToolError = () => new McpError(ErrorCode.InvalidRequest, "页面当前隐藏，不能发起新操作。", { code: "plugin_app_hidden", notAccepted: true })
export class PluginAppController {
  state: PluginAppHostState
  private visible = true
  private readonly confirming = new Set<string>()
  private closed = false
  private closing = false
  private readonly messagePending = new Map<string, AbortController>()
  private readonly pending = new Map<string, AbortController>()
  private readonly listeners = new Set<() => void>()
  constructor(readonly mounted: PluginAppMount, readonly api: DesktopPluginAppsAPI, readonly confirm: AppConfirmation) { this.state = mounted.state }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  snapshot = () => this.state
  update(state: PluginAppHostState): void {
    this.state = state
    if (!state.online || state.app.status !== "open") for (const [requestId, pending] of this.pending) {
      pending.abort(); void this.api.cancelTool({ mountId: this.mounted.mountId, requestId }).catch(() => {})
    }
    if (!state.online || state.app.status !== "open" || !state.availability.canMessage) for (const [requestId, pending] of this.messagePending) {
      pending.abort(); void this.api.cancelMessage({ mountId: this.mounted.mountId, requestId }).catch(() => {})
    }
    this.listeners.forEach(listener => listener())
  }
  assertAvailable(tool = false): void {
    if (this.closed || this.closing || !this.state.online || this.state.app.status !== "open" || (tool && !this.state.availability.canInvokeTools)) throw new Error("页面暂时不能操作；草稿已保留。")
  }
  assertInteraction(tool = false): void {
    this.assertAvailable(tool)
    if (!this.visible) {
      if (tool) throw hiddenToolError()
      throw new Error("页面当前隐藏，不能发起新操作。")
    }
  }
  setVisible(visible: boolean): void {
    this.visible = visible
    if (!visible) for (const id of this.confirming) {
      this.pending.get(id)?.abort(); this.messagePending.get(id)?.abort()
      if (this.pending.has(id)) void this.api.cancelTool({ mountId: this.mounted.mountId, requestId: id }).catch(() => {})
      if (this.messagePending.has(id)) void this.api.cancelMessage({ mountId: this.mounted.mountId, requestId: id }).catch(() => {})
    }
  }
  async refresh(): Promise<void> {
    if (this.closed) return
    const state = await this.api.refresh({ mountId: this.mounted.mountId })
    if (!this.closed) this.update(state)
  }
  async callTool(name: string, args: Record<string, unknown>, signal: AbortSignal) {
    this.assertInteraction(true)
    if (signal.aborted) throw new Error("操作已取消")
    const request = await this.api.prepareTool({ mountId: this.mounted.mountId, name, arguments: args })
    const input = { mountId: this.mounted.mountId, requestId: request.requestId }
    const abort = new AbortController()
    this.pending.set(request.requestId, abort)
    const needsConfirmation = request.policy?.confirmation !== "granted"
    if (needsConfirmation) this.confirming.add(request.requestId)
    const cancel = () => { abort.abort(); void this.api.cancelTool(input).catch(() => {}) }
    signal.addEventListener("abort", cancel, { once: true })
    if (signal.aborted || this.closed || !this.visible) cancel()
    try {
      if (!this.visible && !signal.aborted && !this.closed) throw hiddenToolError()
      if (abort.signal.aborted || (needsConfirmation && !await this.confirm(request, abort.signal))) { cancel(); throw new Error("操作已取消") }
      this.assertInteraction(true)
      if (abort.signal.aborted) throw new Error("操作已取消")
      this.confirming.delete(request.requestId)
      const invoked = await this.api.invokeTool(input)
      if ("notAccepted" in invoked) {
        if (invoked.code === "plugin_app_busy" && invoked.notAccepted === true && invoked.requestId === request.requestId)
          throw new McpError(ErrorCode.InvalidRequest, "plugin_app_busy", { code: "plugin_app_busy", notAccepted: true })
        throw new Error("plugin_app_invalid_admission_response")
      }
      let response = invoked
      while (response.receipt.status === "pending" || response.receipt.status === "running") {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => { abort.signal.removeEventListener("abort", cancelled); resolve() }, 350)
          const cancelled = () => { clearTimeout(timer); reject(new Error("操作已取消，执行结果需查询原回执。")) }
          if (abort.signal.aborted) cancelled(); else abort.signal.addEventListener("abort", cancelled, { once: true })
        })
        this.assertAvailable()
        response = await this.api.getAction(input)
      }
      if (this.closed || abort.signal.aborted) throw new Error("页面已关闭或操作已取消")
      if (response.receipt.executionState === "unknown") {
        this.update({ ...this.state, availability: { ...this.state.availability, canInvokeTools: false, canMessage: false, reason: "action-unconfirmed" } })
        throw new Error("操作结果待核实，请保留草稿。")
      }
      if (response.dataError) throw new Error(`执行状态：${response.receipt.executionState}；结果无法显示：${response.dataError}`)
      if (!response.result) throw new Error(`执行状态：${response.receipt.executionState}；没有可显示的结果。`)
      return CallToolResultSchema.parse(parseMcpCallResultData(response.result))
    } finally {
      signal.removeEventListener("abort", cancel)
      this.pending.delete(request.requestId)
      this.confirming.delete(request.requestId)
      void this.refresh().catch(() => {})
    }
  }
  async sendMessage(role: unknown, content: unknown, signal: AbortSignal) {
    this.assertInteraction()
    if (!this.state.availability.canMessage || signal.aborted) throw new Error("当前不能发送消息，页面草稿已保留。")
    const request = await this.api.prepareMessage({ mountId: this.mounted.mountId, role, content })
    const input = { mountId: this.mounted.mountId, requestId: request.requestId }, abort = new AbortController()
    this.messagePending.set(request.requestId, abort)
    this.confirming.add(request.requestId)
    const cancel = () => { abort.abort(); void this.api.cancelMessage(input).catch(() => {}) }
    signal.addEventListener("abort", cancel, { once: true })
    if (signal.aborted || this.closed || !this.visible) cancel()
    try {
      if (abort.signal.aborted || !await this.confirm(request, abort.signal)) { cancel(); throw new Error("发送已取消，草稿已保留。") }
      this.assertInteraction()
      if (abort.signal.aborted || !this.state.availability.canMessage) throw new Error("发送已取消，草稿已保留。")
      this.confirming.delete(request.requestId)
      try { await this.api.submitMessage(input) }
      catch (error) {
        // Lost delivery acknowledgements are recovered by reading, never by starting a new message.
        try { await this.api.getMessageSubmission(input) } catch { void this.api.cancelMessage(input).catch(() => {}); throw error }
      }
      if (this.closed || abort.signal.aborted) throw new Error("页面已关闭或发送已取消；原消息可能已接收。")
      return {}
    } finally {
      if (this.confirming.has(request.requestId)) void this.api.cancelMessage(input).catch(() => {})
      signal.removeEventListener("abort", cancel); this.messagePending.delete(request.requestId); this.confirming.delete(request.requestId)
      void this.refresh().catch(() => {})
    }
  }
  async updateModelContext(content?: unknown, structuredContent?: unknown) {
    this.assertInteraction()
    const entry = await this.api.updateModelContext({ mountId: this.mounted.mountId, content, structuredContent })
    this.assertInteraction()
    pluginAppModelContexts.put(entry)
    return {}
  }
  suspend(): void { this.update({ ...this.state, online: false }); for (const pending of this.pending.values()) pending.abort() }
  async dispose(explicit = false): Promise<void> {
    if (this.closed) return
    if (this.closing) throw new Error("页面正在关闭")
    this.closing = true
    for (const pending of this.pending.values()) pending.abort()
    this.pending.clear()
    for (const [requestId, pending] of this.messagePending) { pending.abort(); void this.api.cancelMessage({ mountId: this.mounted.mountId, requestId }).catch(() => {}) }
    this.messagePending.clear()
    try {
      if (explicit) await this.api.close({ mountId: this.mounted.mountId, expectedRevision: this.state.app.controlRevision })
      else await this.api.release({ mountId: this.mounted.mountId })
      this.closed = true
    } catch (error) {
      await this.refresh().catch(() => {})
      throw error
    } finally { this.closing = false }
  }
}

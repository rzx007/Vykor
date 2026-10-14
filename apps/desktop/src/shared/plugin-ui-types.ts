import type {
  DismissPluginUiInput,
  InvokePluginUiActionInput,
  PluginUiActionReceipt,
  PluginUiActionDescription,
  PluginUiAvailability,
  PluginUiInstanceRecord,
  PluginUiSurface,
  PluginUiViewSnapshot,
  PluginUiConversationPrepared,
  PluginUiConversationRequest,
  PluginUiConversationReceipt,
} from "@vykor/client"
export interface DesktopPluginUiTarget {
  sessionId: string
  instanceId: string
}
export interface DesktopPluginUiMountInput extends DesktopPluginUiTarget {
  surface: PluginUiSurface
}
export interface PluginUiHostState {
  snapshot: Omit<PluginUiViewSnapshot, "appearance" | "capabilities">
  plugin: { id: string; version: string }
  title: string
  availability: PluginUiAvailability
  conversation: { draft: boolean; submit: boolean }
  actions: Array<Pick<PluginUiActionDescription, "id" | "label" | "toolName" | "completion">>
}
export interface DesktopPluginUiMountResult {
  mountId: string
  url: string
  state: PluginUiHostState
}
export interface DesktopPluginUiCapabilities {
  available: boolean
}
export interface DesktopPluginUiAPI {
  capabilities(): Promise<DesktopPluginUiCapabilities>
  mount(input: DesktopPluginUiMountInput): Promise<DesktopPluginUiMountResult>
  getState(input: DesktopPluginUiTarget): Promise<PluginUiHostState>
  invokeAction(input: {
    mountId: string
    input: InvokePluginUiActionInput
  }): Promise<PluginUiActionReceipt>
  getAction(input: { mountId: string; requestId: string }): Promise<PluginUiActionReceipt>
  prepareConversation(input: {
    mountId: string
    input: PluginUiConversationRequest
  }): Promise<PluginUiConversationPrepared>
  submitConversation(input: {
    mountId: string
    requestId: string
    input: Omit<PluginUiConversationRequest, "mode">
  }): Promise<PluginUiConversationReceipt>
  getConversationSubmission(input: { requestId: string }): Promise<PluginUiConversationReceipt>
  dismiss(
    input: DesktopPluginUiTarget & { input: DismissPluginUiInput }
  ): Promise<PluginUiInstanceRecord>
  unmount(input: { mountId: string }): Promise<void>
  onRevoked(listener: (event: { mountId: string }) => void): () => void
}

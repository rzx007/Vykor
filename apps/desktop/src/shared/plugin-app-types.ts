import type { PluginAppActionResponse, PluginAppRecord, PluginAppResponse, PluginAppSource, PluginAppSubmissionReceipt, PluginAppToolPolicy, VykorClient } from "@rzx/client"
export type PluginAppHostState = Omit<PluginAppResponse, "lease"> & { online: boolean }
export interface PluginAppMount { mountId: string; url: string; state: PluginAppHostState }
export interface PluginAppPreparedTool { requestId: string; toolName: string; args: Record<string, unknown>; expectedRevision: number; policy?: PluginAppToolPolicy }
export type PluginAppToolInvocationResult = PluginAppActionResponse | { code: "plugin_app_busy"; notAccepted: true; requestId: string }
export interface PluginAppPreparedMessage { pluginId: string; source: PluginAppSource; requestId: string; text: string; data: unknown; expectedRevision: number }
export type PluginAppConfirmation = PluginAppPreparedTool | PluginAppPreparedMessage
export interface PluginAppModelContext { id: string; source: PluginAppSource; pluginId: string; text: string; data: unknown }
export interface DesktopPluginAppsAPI {
  prepareMessage(input: { mountId: string; content: unknown; role: unknown }): Promise<PluginAppPreparedMessage>
  submitMessage(input: { mountId: string; requestId: string }): Promise<PluginAppSubmissionReceipt>
  getMessageSubmission(input: { mountId: string; requestId: string }): Promise<PluginAppSubmissionReceipt>
  cancelMessage(input: { mountId: string; requestId: string }): Promise<void>
  updateModelContext(input: { mountId: string; content?: unknown; structuredContent?: unknown }): Promise<PluginAppModelContext>

  catalog(input: { sessionId: string }): ReturnType<VykorClient["pluginApps"]["catalog"]>
  open(input: { sessionId: string; pluginId: string; surfaceId: string }): Promise<PluginAppMount>
  openToolResult?(input: { sessionId: string; sourcePartId: string }): Promise<{ mounted: PluginAppMount; initial: { sourcePartId: string; arguments: Record<string, unknown>; result: unknown; dataError?: string } }>
  mount(input: PluginAppSource): Promise<PluginAppMount>
  refresh(input: { mountId: string }): Promise<PluginAppHostState>
  prepareTool(input: { mountId: string; name: string; arguments: Record<string, unknown> }): Promise<PluginAppPreparedTool>
  invokeTool(input: { mountId: string; requestId: string }): Promise<PluginAppToolInvocationResult>
  getAction(input: { mountId: string; requestId: string }): Promise<PluginAppActionResponse>
  cancelTool(input: { mountId: string; requestId: string }): Promise<void>
  readResource(input: { mountId: string; uri: string }): Promise<{ contents: unknown[] }>
  listResources(input: { mountId: string; cursor?: string }): Promise<{ resources: unknown[]; nextCursor?: string }>
  listResourceTemplates(input: { mountId: string; cursor?: string }): Promise<{ resourceTemplates: unknown[]; nextCursor?: string }>
  close(input: { mountId: string; expectedRevision: number }): Promise<{ app: PluginAppRecord }>
  rejectMenuOpen(input: { mountId: string }): Promise<{ closed: boolean }>
  release(input: { mountId: string }): Promise<void>
  onRevoked(listener: (input: { mountId: string }) => void): () => void
  onResourcesChanged?(listener: (input: { mountId: string }) => void): () => void
}

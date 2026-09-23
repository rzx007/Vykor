export type DesktopMcpAuthStatus =
  | "not-configured"
  | "not-logged-in"
  | "valid"
  | "expired-refreshable"
  | "reauthentication-required"
  | "static"
  | "unsupported"

export type DesktopMcpAuthMode = "none" | "oauth" | "bearer" | "custom"

export type DesktopMcpRuntimeStatus =
  | "connected"
  | "disconnected"
  | "error"
  | "unavailable"

export interface DesktopMcpServer {
  name: string
  enabled: boolean
  transport: "stdio" | "http" | "sse"
  /** Secret-free display string: URL without userinfo/query/fragment, or the stdio command. */
  summary: string
  authMode: DesktopMcpAuthMode
  authStatus: DesktopMcpAuthStatus
  scopes: string[]
  runtimeStatus: DesktopMcpRuntimeStatus
}

export interface DesktopMcpSnapshot {
  servers: DesktopMcpServer[]
}

export interface DesktopMcpLoginInput {
  name: string
  scopes: string[]
}

export interface DesktopMcpLogoutInput {
  name: string
}

export interface DesktopMcpGetConfigInput {
  name: string
}

export interface DesktopMcpAddInput {
  name: string
  config: Record<string, unknown>
}

export interface DesktopMcpUpdateInput {
  name: string
  config: Record<string, unknown>
  /** The config the editor opened; the main process rejects a stale overwrite. */
  expectedConfig: Record<string, unknown>
}

export interface DesktopMcpRemoveInput {
  name: string
}

export interface DesktopMcpSetEnabledInput {
  name: string
  enabled: boolean
}

export interface DesktopMcpExportResult {
  mcpServers: Record<string, unknown>
}

export interface DesktopMcpOperationResult {
  persisted: boolean
  credentialRemoved: boolean
  runtimeFailures: Array<{ runtimeId: string; message: string }>
  /** Fresh, secret-free snapshot taken after the operation. */
  snapshot: DesktopMcpSnapshot
}

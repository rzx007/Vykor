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
  transport: "stdio" | "http" | "sse"
  endpoint?: string
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

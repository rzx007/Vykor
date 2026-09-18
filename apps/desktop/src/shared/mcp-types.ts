export type DesktopMcpAuthStatus =
  | "not-configured"
  | "not-logged-in"
  | "valid"
  | "expired-refreshable"
  | "reauthentication-required"
  | "static"
  | "unsupported"

export interface DesktopMcpServer {
  name: string
  transport: "stdio" | "http" | "sse"
  endpoint?: string
  authStatus: DesktopMcpAuthStatus
  scopes: string[]
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

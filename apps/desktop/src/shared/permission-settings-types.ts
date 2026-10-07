import type { DesktopPermissionMode } from "./session-types"

export interface DesktopPermissionRules {
  mode: DesktopPermissionMode
  allowedTools?: string[]
  deniedTools?: string[]
  autoApproveTools?: string[]
  deniedCommands?: string[]
  pathRules?: Array<{ pattern: string; allow: boolean }>
}

export interface DesktopIsolationSettings {
  enabled: boolean
  failIfUnavailable: boolean
  enabledPlatforms: Array<"linux" | "wsl" | "macos">
  filesystem: {
    allowRead: string[]
    denyRead: string[]
    allowWrite: string[]
    denyWrite: string[]
    extraAllowedRoots: string[]
  }
  network: {
    mode: "none" | "bridge" | "host" | "proxy"
    allowedDomains: string[]
    deniedDomains: string[]
    strictDomainPolicy: boolean
  }
  srt: { runtimeCommand: string }
}

export interface DesktopPermissionSettingsSnapshot {
  permission: DesktopPermissionRules
  sandbox: DesktopIsolationSettings
  isolationAvailable: boolean
  isolationReason: string | null
  environment: "native" | "wsl"
  browserDeveloperMode: boolean
  toolApprovals: Array<{ id: string; sessionId: string; toolName: string; updatedAt: number }>
  browserApprovals: Array<{ sessionId: string; origin: string }>
}

export interface UpdateDesktopPermissionSettingsInput {
  permission: DesktopPermissionRules
  expectedPermission: DesktopPermissionRules
}

export interface CheckDesktopPermissionInput {
  permission: DesktopPermissionRules
  toolName: string
  path?: string
  command?: string
  cwd: string
}

export interface RevokeDesktopApprovalInput {
  kind: "tool" | "browser"
  id?: string
  sessionId?: string
  origin?: string
}

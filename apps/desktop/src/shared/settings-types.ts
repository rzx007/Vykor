export type DesktopWorkStyle = "practical" | "efficient"
export type DesktopNotificationMode = "never" | "when_unfocused" | "always"
export type DesktopAgentEnvironment = "native" | "wsl"
export type DesktopDaemonOnboardingState = "pending" | "enabled" | "dismissed"
export type DesktopInstallIdentity = "new" | "existing"

export interface DesktopDaemonAutoStartSnapshot {
  configured: boolean
  serviceState: "not-installed" | "stopped" | "running" | "unknown"
  enabled: boolean
  onboardingState: DesktopDaemonOnboardingState
  showOnboarding: boolean
}

export interface DesktopSettingsSnapshot {
  workStyle: DesktopWorkStyle
  notificationMode: DesktopNotificationMode
  agentEnvironment: DesktopAgentEnvironment
  showReasoning: boolean
  restartRequired: boolean
  defaultOpenerId: string | null
  defaultTerminalShellId: string | null
  wslSupported?: boolean
}

export interface UpdateDesktopWorkStyleInput {
  workStyle: DesktopWorkStyle
}

export interface UpdateDesktopNotificationModeInput {
  notificationMode: DesktopNotificationMode
}

export interface UpdateDesktopAgentEnvironmentInput {
  environment: "native" | "wsl"
}

export interface UpdateDesktopReasoningVisibilityInput {
  showReasoning: boolean
}

export interface UpdateDesktopDefaultOpenerInput {
  defaultOpenerId: string
}

export interface UpdateDesktopDefaultTerminalShellInput {
  defaultTerminalShellId: string | null
}

export function normalizeDefaultOpenerId(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

export function normalizeDefaultTerminalShellId(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  if (!trimmed || trimmed === "system") return null
  return trimmed
}

export function buildDesktopSettingsSnapshot(
  settings: Record<string, unknown>,
  preferences: Partial<{
    notificationMode: unknown
    defaultOpenerId: unknown
    defaultTerminalShellId: unknown
  }> = {},
  options: Partial<{ restartRequired: boolean; wslSupported: boolean }> = {}
): DesktopSettingsSnapshot {
  return {
    workStyle: isDesktopWorkStyle(settings.workStyle) ? settings.workStyle : "practical",
    notificationMode: isDesktopNotificationMode(preferences.notificationMode)
      ? preferences.notificationMode
      : "when_unfocused",
    agentEnvironment: resolveDesktopAgentEnvironment(settings.agentEnvironment),
    showReasoning: settings.showReasoning !== false,
    restartRequired: options.restartRequired ?? false,
    defaultOpenerId: normalizeDefaultOpenerId(preferences.defaultOpenerId),
    defaultTerminalShellId: normalizeDefaultTerminalShellId(preferences.defaultTerminalShellId),
    wslSupported: options.wslSupported ?? false,
  }
}

function resolveDesktopAgentEnvironment(value: unknown): DesktopAgentEnvironment {
  return isRecord(value) && value.kind === "wsl" ? "wsl" : "native"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

export function isDesktopWorkStyle(value: unknown): value is DesktopWorkStyle {
  return value === "practical" || value === "efficient"
}

export function isDesktopNotificationMode(value: unknown): value is DesktopNotificationMode {
  return value === "never" || value === "when_unfocused" || value === "always"
}

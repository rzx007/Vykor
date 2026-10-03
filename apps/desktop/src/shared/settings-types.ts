export type DesktopWorkStyle = "practical" | "efficient"
export type DesktopNotificationMode = "never" | "when_unfocused" | "always"
export type DesktopNotificationSound = "completed" | "needs_input" | "failed"
export type DesktopNotificationSounds = Record<DesktopNotificationSound, string>

export const DESKTOP_SOUND_OPTIONS = [
  { value: "none", label: "无声音" },
  ...(
    [
      ["alert", "Alert", 10],
      ["bip-bop", "Bip-bop", 10],
      ["staplebops", "Staplebops", 7],
      ["nope", "Nope", 12],
      ["yup", "Yup", 6],
    ] as const
  ).flatMap(([prefix, label, count]) =>
    Array.from({ length: count }, (_, index) => {
      const number = String(index + 1).padStart(2, "0")
      return { value: `${prefix}-${number}`, label: `${label} ${number}` }
    })
  ),
]

const defaultNotificationSounds: DesktopNotificationSounds = {
  completed: "staplebops-01",
  needs_input: "staplebops-02",
  failed: "nope-03",
}

export function isDesktopSoundId(value: unknown): value is string {
  return typeof value === "string" && DESKTOP_SOUND_OPTIONS.some((option) => option.value === value)
}
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
  notificationSounds: DesktopNotificationSounds
  agentEnvironment: DesktopAgentEnvironment
  showReasoning: boolean
  browserDeveloperMode: boolean
  restartRequired: boolean
  defaultOpenerId: string | null
  defaultTerminalShellId: string | null
  customInstructions: string
  memoryEnabled: boolean
  autoExtractEnabled: boolean
  wslSupported?: boolean
}

export interface UpdateDesktopWorkStyleInput {
  workStyle: DesktopWorkStyle
}

export interface UpdateDesktopCustomInstructionsInput {
  content: string
}

export interface UpdateDesktopMemorySettingsInput {
  enabled?: boolean
  autoExtractEnabled?: boolean
}

export interface UpdateDesktopNotificationModeInput {
  notificationMode: DesktopNotificationMode
}

export interface UpdateDesktopNotificationSoundsInput {
  notificationSounds: DesktopNotificationSounds
}

export function normalizeNotificationSounds(value: unknown): DesktopNotificationSounds {
  const sounds = isRecord(value) ? value : {}
  const read = (status: DesktopNotificationSound): string => {
    const sound = sounds[status]
    if (sound === false) return "none"
    return isDesktopSoundId(sound) ? sound : defaultNotificationSounds[status]
  }
  return {
    completed: read("completed"),
    needs_input: read("needs_input"),
    failed: read("failed"),
  }
}

export interface UpdateDesktopAgentEnvironmentInput {
  environment: "native" | "wsl"
}

export interface UpdateDesktopReasoningVisibilityInput {
  showReasoning: boolean
}

export interface UpdateDesktopBrowserDeveloperModeInput {
  enabled: boolean
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
    notificationSounds: unknown
    defaultOpenerId: unknown
    defaultTerminalShellId: unknown
    browserDeveloperMode: unknown
  }> = {},
  options: Partial<{ restartRequired: boolean; wslSupported: boolean }> = {}
): DesktopSettingsSnapshot {
  const memory = isRecord(settings.memory) ? settings.memory : {}
  return {
    workStyle: isDesktopWorkStyle(settings.workStyle) ? settings.workStyle : "practical",
    notificationMode: isDesktopNotificationMode(preferences.notificationMode)
      ? preferences.notificationMode
      : "when_unfocused",
    notificationSounds: normalizeNotificationSounds(preferences.notificationSounds),
    agentEnvironment: resolveDesktopAgentEnvironment(settings.agentEnvironment),
    showReasoning: settings.showReasoning !== false,
    browserDeveloperMode: preferences.browserDeveloperMode === true,
    restartRequired: options.restartRequired ?? false,
    defaultOpenerId: normalizeDefaultOpenerId(preferences.defaultOpenerId),
    defaultTerminalShellId: normalizeDefaultTerminalShellId(preferences.defaultTerminalShellId),
    customInstructions: typeof settings.systemPrompt === "string" ? settings.systemPrompt : "",
    memoryEnabled: memory.enabled !== false,
    autoExtractEnabled: memory.autoExtractEnabled !== false,
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

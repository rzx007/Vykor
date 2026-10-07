import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { normalizeNotificationEvents, type DesktopNotificationEvents } from "../../../shared/notification-settings-types"
import { join } from "node:path"
import { validateTerminalSettings, type TerminalSettings } from "../../../shared/terminal-settings-types"

import {
  isDesktopNotificationMode,
  normalizeNotificationSounds,
  normalizeDefaultOpenerId,
  normalizeDefaultTerminalShellId,
  type DesktopDaemonOnboardingState,
  type DesktopInstallIdentity,
  type DesktopNotificationMode,
  type DesktopNotificationSounds,
} from "../../../shared/settings-types"

export interface DesktopPreferences {
  notificationMode: DesktopNotificationMode
  notificationSounds?: DesktopNotificationSounds
  notificationEvents?: DesktopNotificationEvents
  notifiedEventIds?: string[]
  browserDeveloperMode?: boolean
  noteQuickShortcut?: string
  noteWindowAlwaysOnTop?: boolean
  defaultOpenerId?: string
  defaultTerminalShellId?: string
  terminal?: TerminalSettings
  installIdentity?: DesktopInstallIdentity
  daemonOnboardingState?: DesktopDaemonOnboardingState
}

export type DesktopPreferencesPatch = Omit<
  Partial<DesktopPreferences>,
  "defaultTerminalShellId"
> & {
  defaultTerminalShellId?: string | null
}

const defaults: DesktopPreferences = { notificationMode: "when_unfocused" }

export function resolveDesktopPreferencesPath(userDataDir: string): string {
  return join(userDataDir, "desktop-preferences.json")
}

export function getDesktopPreferencesAt(userDataDir: string): DesktopPreferences {
  const filePath = resolveDesktopPreferencesPath(userDataDir)
  if (!existsSync(filePath)) return defaults
  try {
    const raw = JSON.parse(readFileSync(filePath, "utf8")) as Partial<DesktopPreferences>
    const defaultOpenerId = normalizeDefaultOpenerId(raw.defaultOpenerId)
    const defaultTerminalShellId = normalizeDefaultTerminalShellId(raw.defaultTerminalShellId)
    return {
      notificationMode: isDesktopNotificationMode(raw.notificationMode)
        ? raw.notificationMode
        : defaults.notificationMode,
      ...(raw.notificationSounds !== undefined
        ? { notificationSounds: normalizeNotificationSounds(raw.notificationSounds) }
        : {}),
      ...(raw.notificationEvents ? { notificationEvents: normalizeNotificationEvents(raw.notificationEvents) } : {}),
      ...(Array.isArray(raw.notifiedEventIds) ? { notifiedEventIds: raw.notifiedEventIds.filter((value): value is string => typeof value === "string").slice(-1000) } : {}),
      ...(raw.browserDeveloperMode === true ? { browserDeveloperMode: true } : {}),
      ...(typeof raw.noteQuickShortcut === "string" ? { noteQuickShortcut: raw.noteQuickShortcut } : {}),
      ...(typeof raw.noteWindowAlwaysOnTop === "boolean" ? { noteWindowAlwaysOnTop: raw.noteWindowAlwaysOnTop } : {}),
      ...(defaultOpenerId ? { defaultOpenerId } : {}),
      ...(defaultTerminalShellId ? { defaultTerminalShellId } : {}),
      ...(raw.terminal ? { terminal: validateTerminalSettings(raw.terminal) } : {}),
      ...(isInstallIdentity(raw.installIdentity) ? { installIdentity: raw.installIdentity } : {}),
      ...(isOnboardingState(raw.daemonOnboardingState)
        ? { daemonOnboardingState: raw.daemonOnboardingState }
        : {}),
    }
  } catch {
    return defaults
  }
}

export function patchDesktopPreferencesAt(
  userDataDir: string,
  patch: DesktopPreferencesPatch
): DesktopPreferences {
  const next = { ...getDesktopPreferencesAt(userDataDir), ...patch }
  const defaultOpenerId = normalizeDefaultOpenerId(next.defaultOpenerId)
  const defaultTerminalShellId = normalizeDefaultTerminalShellId(next.defaultTerminalShellId)
  const persisted: DesktopPreferences = {
    notificationMode: next.notificationMode,
    ...(next.notificationSounds !== undefined
      ? { notificationSounds: normalizeNotificationSounds(next.notificationSounds) }
      : {}),
    ...(next.notificationEvents ? { notificationEvents: normalizeNotificationEvents(next.notificationEvents) } : {}),
    ...(Array.isArray(next.notifiedEventIds) ? { notifiedEventIds: next.notifiedEventIds.filter((value): value is string => typeof value === "string").slice(-1000) } : {}),
    ...(next.browserDeveloperMode === true ? { browserDeveloperMode: true } : {}),
    ...(typeof next.noteQuickShortcut === "string" ? { noteQuickShortcut: next.noteQuickShortcut } : {}),
    ...(typeof next.noteWindowAlwaysOnTop === "boolean" ? { noteWindowAlwaysOnTop: next.noteWindowAlwaysOnTop } : {}),
    ...(defaultOpenerId ? { defaultOpenerId } : {}),
    ...(defaultTerminalShellId ? { defaultTerminalShellId } : {}),
    ...(next.terminal ? { terminal: validateTerminalSettings(next.terminal) } : {}),
    ...(isInstallIdentity(next.installIdentity) ? { installIdentity: next.installIdentity } : {}),
    ...(isOnboardingState(next.daemonOnboardingState)
      ? { daemonOnboardingState: next.daemonOnboardingState }
      : {}),
  }
  const target = resolveDesktopPreferencesPath(userDataDir)
  const temporary = `${target}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, JSON.stringify(persisted, null, 2), { encoding: "utf8", mode: 0o600 })
    renameSync(temporary, target)
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary)
  }
  return persisted
}

function isInstallIdentity(value: unknown): value is DesktopInstallIdentity {
  return value === "new" || value === "existing"
}

function isOnboardingState(value: unknown): value is DesktopDaemonOnboardingState {
  return value === "pending" || value === "enabled" || value === "dismissed"
}

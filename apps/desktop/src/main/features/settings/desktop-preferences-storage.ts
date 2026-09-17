import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import {
  isDesktopNotificationMode,
  normalizeDefaultOpenerId,
  normalizeDefaultTerminalShellId,
  type DesktopDaemonOnboardingState,
  type DesktopInstallIdentity,
  type DesktopNotificationMode,
} from "../../../shared/settings-types"

export interface DesktopPreferences {
  notificationMode: DesktopNotificationMode
  defaultOpenerId?: string
  defaultTerminalShellId?: string
  installIdentity?: DesktopInstallIdentity
  daemonOnboardingState?: DesktopDaemonOnboardingState
}

export type DesktopPreferencesPatch = Omit<Partial<DesktopPreferences>, "defaultTerminalShellId"> & {
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
      ...(defaultOpenerId ? { defaultOpenerId } : {}),
      ...(defaultTerminalShellId ? { defaultTerminalShellId } : {}),
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
    ...(defaultOpenerId ? { defaultOpenerId } : {}),
    ...(defaultTerminalShellId ? { defaultTerminalShellId } : {}),
    ...(isInstallIdentity(next.installIdentity) ? { installIdentity: next.installIdentity } : {}),
    ...(isOnboardingState(next.daemonOnboardingState)
      ? { daemonOnboardingState: next.daemonOnboardingState }
      : {}),
  }
  writeFileSync(resolveDesktopPreferencesPath(userDataDir), JSON.stringify(persisted, null, 2), "utf8")
  return persisted
}

function isInstallIdentity(value: unknown): value is DesktopInstallIdentity {
  return value === "new" || value === "existing"
}

function isOnboardingState(value: unknown): value is DesktopDaemonOnboardingState {
  return value === "pending" || value === "enabled" || value === "dismissed"
}

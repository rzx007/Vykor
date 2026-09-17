import { existsSync } from "node:fs"
import { join } from "node:path"

import { app } from "electron"

import {
  getDesktopPreferencesAt,
  patchDesktopPreferencesAt,
  resolveDesktopPreferencesPath,
  type DesktopPreferences,
  type DesktopPreferencesPatch,
} from "./desktop-preferences-storage"

export type { DesktopPreferences } from "./desktop-preferences-storage"

export function getDesktopPreferences(): DesktopPreferences {
  return getDesktopPreferencesAt(app.getPath("userData"))
}

export function patchDesktopPreferences(patch: DesktopPreferencesPatch): DesktopPreferences {
  return patchDesktopPreferencesAt(app.getPath("userData"), patch)
}

export function initializeDesktopInstallIdentity(): DesktopPreferences {
  const current = getDesktopPreferences()
  if (current.installIdentity && current.daemonOnboardingState) return current

  const userData = app.getPath("userData")
  const existing = [
    getDesktopPreferencesPath(),
    join(userData, "desktop-pet.json"),
    join(userData, "Local Storage", "leveldb"),
  ].some(existsSync)
  return patchDesktopPreferences({
    installIdentity: existing ? "existing" : "new",
    daemonOnboardingState: existing ? "dismissed" : "pending",
  })
}

export function getDesktopPreferencesPath(): string {
  return resolveDesktopPreferencesPath(app.getPath("userData"))
}

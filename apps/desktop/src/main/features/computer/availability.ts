import { app } from "electron"
import type { DesktopComputerAvailability, DesktopComputerSettings } from "../../../shared/computer-types"
import { getDesktopPreferences } from "../settings/desktop-preferences"
import { assertBundledWindowsDriverIntegrity } from "./windows-driver"

export function computerSettingsPolicy(): Pick<DesktopComputerSettings, "enabled" | "alwaysForeground" | "locked"> {
  const { computerEnabled, computerAlwaysForeground } = getDesktopPreferences()
  const alwaysForeground = computerAlwaysForeground === true
  if (process.platform !== "win32" || process.arch !== "x64")
    return { enabled: false, alwaysForeground, locked: "unsupported" }
  const launch = process.env.VYKOR_COMPUTER_USE
  if (launch === "0") return { enabled: false, alwaysForeground, locked: "launch_disabled" }
  return { enabled: computerEnabled ?? (!app.isPackaged || launch === "1"), alwaysForeground }
}

export function computerPlatformAvailability(): "unsupported" | "disabled" | "enabled" {
  const { enabled, locked } = computerSettingsPolicy()
  return locked === "unsupported" ? "unsupported" : enabled ? "enabled" : "disabled"
}

export async function computerAvailability(signal?: AbortSignal): Promise<DesktopComputerAvailability> {
  const platform = computerPlatformAvailability()
  if (platform !== "enabled") return platform
  return computerDriverAvailability(signal)
}

export async function computerDriverAvailability(signal?: AbortSignal): Promise<"missing_driver" | "ready"> {
  try {
    await assertBundledWindowsDriverIntegrity(signal)
    return "ready"
  } catch {
    signal?.throwIfAborted()
    return "missing_driver"
  }
}

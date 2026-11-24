import { app } from "electron"
import { assertBundledWindowsDriverIntegrity } from "./windows-driver"

export function computerPlatformAvailability(): "unsupported" | "disabled" | "enabled" {
  if (process.platform !== "win32" || process.arch !== "x64") return "unsupported"
  const setting = process.env.VYKOR_COMPUTER_USE
  if (setting === "0" || (app.isPackaged && setting !== "1")) return "disabled"
  return "enabled"
}

export async function computerAvailability(signal?: AbortSignal): Promise<"unsupported" | "disabled" | "missing_driver" | "ready"> {
  const platform = computerPlatformAvailability()
  if (platform !== "enabled") return platform
  try {
    await assertBundledWindowsDriverIntegrity(signal)
    return "ready"
  } catch {
    signal?.throwIfAborted()
    return "missing_driver"
  }
}

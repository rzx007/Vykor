import { statSync } from "node:fs"
import { join } from "node:path"
import { app } from "electron"

export function computerAvailability(): "unsupported" | "disabled" | "missing_driver" | "ready" {
  if (process.platform !== "win32" || process.arch !== "x64") return "unsupported"
  const setting = process.env.VYKOR_COMPUTER_USE
  if (setting === "0" || (app.isPackaged && setting !== "1")) return "disabled"
  const directory = app.isPackaged ? join(process.resourcesPath, "computer-windows")
    : join(app.getAppPath(), "out", "computer-windows", "x64")
  try {
    return ["cua-driver.exe", "driver-release.json", "CUA-LICENSE.txt"].every(file =>
      statSync(join(directory, file), { throwIfNoEntry: false })?.isFile() === true)
      ? "ready" : "missing_driver"
  } catch {
    return "missing_driver"
  }
}

import { getDataRoot } from "@vykor/host-config/paths"
import { spawn } from "node:child_process"
import { join } from "node:path"
import { app } from "electron"
import {
  daemonPidAlive,
  isWindowsDaemonServiceEnabled,
  readDaemonRegistry,
  runRegisteredDaemon,
  setHostResponseLocale,
  shouldStartManagedDaemon,
} from "@vykor/server/daemon-host"
import { buildOutsideProjectRoot } from "../session/outside-project-workspace"

export type DesktopDaemonMode = "service" | "watchdog" | "on-demand"

export function resolveDesktopDaemonMode(argv: readonly string[]): DesktopDaemonMode | null {
  if (argv.includes("--daemon-service")) return "service"
  if (argv.includes("--daemon-watchdog")) return "watchdog"
  if (argv.includes("--daemon-on-demand")) return "on-demand"
  return null
}

export async function runDesktopDaemonEntry(mode: DesktopDaemonMode): Promise<void> {
  if (mode === "watchdog") {
    const registry = readDaemonRegistry()
    if (registry && daemonPidAlive(registry.pid)) return
    if (!(await shouldStartManagedDaemon())) return
    const args = [...(app.isPackaged ? [] : [app.getAppPath()]), "--data-root", getDataRoot(), "--daemon-service"]
    const child = spawn(process.execPath, args, { detached: true, stdio: "ignore", windowsHide: true })
    child.unref()
    return
  }

  setHostResponseLocale(app.getPreferredSystemLanguages()[0])
  await runRegisteredDaemon({
    version: app.getVersion(),
    launcher: "desktop",
    supervised: mode === "service",
    ...(mode === "service" && process.platform === "win32"
      ? { shouldStart: isWindowsDaemonServiceEnabled }
      : {}),
    legacyDataLocationPath: join(app.getPath("userData"), "runtime-data-location.json"),
    outsideProjectWorkspaceRoot: buildOutsideProjectRoot(app.getPath("documents")),
  })
}

import { execFile } from "node:child_process"
import { realpath } from "node:fs/promises"
import { join, relative } from "node:path"
import { promisify } from "node:util"
import { app } from "electron"
import type { DaemonRegistry } from "@vykor/server/daemon-host"

const run = promisify(execFile)

export async function isWindowsOnDemandDaemon(registry: DaemonRegistry, signal: AbortSignal): Promise<boolean> {
  if (process.platform !== "win32" || registry.launcher !== "desktop" || registry.supervised !== false ||
      !Number.isSafeInteger(registry.pid) || registry.pid <= 0 || registry.pid === process.pid) return false
  try {
    // CIM is only consulted while deciding whether a previously running daemon can be replaced.
    const script = `
      [Console]::OutputEncoding = [Text.Encoding]::UTF8
      $desktop = Get-CimInstance Win32_Process -Filter "ProcessId = $env:VYKOR_IDENTITY_DESKTOP_PID" -ErrorAction Stop
      $daemon = Get-CimInstance Win32_Process -Filter "ProcessId = $env:VYKOR_IDENTITY_DAEMON_PID" -ErrorAction Stop
      if ($null -eq $desktop -or $null -eq $daemon -or $desktop.SessionId -ne $daemon.SessionId) { exit 1 }
      [pscustomobject]@{
        executable = $daemon.ExecutablePath
        command = $daemon.CommandLine
        createdAt = ([DateTimeOffset] $daemon.CreationDate).ToUnixTimeMilliseconds()
      } | ConvertTo-Json -Compress
    `
    const powerShell = join(process.env.SystemRoot ?? "C:/Windows", "System32/WindowsPowerShell/v1.0/powershell.exe")
    const { stdout } = await run(powerShell, ["-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true,
      timeout: 6_000,
      signal,
      env: {
        ...process.env,
        VYKOR_IDENTITY_DESKTOP_PID: String(process.pid),
        VYKOR_IDENTITY_DAEMON_PID: String(registry.pid),
      },
    })
    const result = JSON.parse(stdout) as { executable?: string; command?: string; createdAt?: number }
    if (!result.executable || typeof result.command !== "string" || typeof result.createdAt !== "number" ||
      result.createdAt <= 0 || result.createdAt > registry.startedAt ||
      !/(?:^|\s)--daemon-on-demand(?:\s|$)/.test(result.command)) return false
    const registeredExecutable = await realpath(result.executable)
    const desktopExecutable = await realpath(process.execPath)
    return !relative(desktopExecutable, registeredExecutable) &&
      (app.isPackaged || result.command.toLowerCase().includes(app.getAppPath().toLowerCase()))
  } catch {
    return false
  }
}

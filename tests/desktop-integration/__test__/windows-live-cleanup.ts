import { execFileSync } from "node:child_process"
import { join } from "node:path"
import type { WindowsAppWindow } from "../../../apps/desktop/src/main/features/computer/windows-apps"

const windowsRoot = process.env.SystemRoot ?? String.raw`C:\Windows`
const powershell = join(windowsRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")

function runPowerShell(script: string, values: Record<string, string> = {}) {
  return execFileSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8", windowsHide: true, timeout: 12_000, env: { ...process.env, ...values },
  }).trim()
}

export function closeNewWindow(window: WindowsAppWindow, startedAfter: number) {
  runPowerShell(String.raw`
    $ErrorActionPreference = 'Stop'
    $appProcess = Get-Process -Id ([int]$env:VYKOR_LIVE_APP_PID) -ErrorAction SilentlyContinue
    $frame = Get-Process -Id ([int]$env:VYKOR_LIVE_WINDOW_PID) -ErrorAction SilentlyContinue
    if (!$appProcess -or !$frame) { return }
    if ($appProcess.SessionId -ne [int]$env:VYKOR_LIVE_SESSION -or
        $frame.SessionId -ne [int]$env:VYKOR_LIVE_SESSION -or
        $frame.StartTime.ToFileTimeUtc().ToString() -ne $env:VYKOR_LIVE_FRAME_START -or
        $appProcess.StartTime.ToFileTimeUtc().ToString() -ne $env:VYKOR_LIVE_APP_START -or
        ([DateTimeOffset]$appProcess.StartTime).ToUnixTimeMilliseconds() -lt [long]$env:VYKOR_LIVE_STARTED_AFTER) {
      throw 'Could not verify the test-owned window before cleanup'
    }
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class VykorLiveCleanup {
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);
}
'@
    $handle = [IntPtr][long]$env:VYKOR_LIVE_HWND
    [uint32]$owner = 0
    [void][VykorLiveCleanup]::GetWindowThreadProcessId($handle, [ref]$owner)
    if ($owner -eq 0) { return }
    if ($owner -ne $frame.Id -or ![VykorLiveCleanup]::PostMessage($handle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)) {
      throw 'Could not close the test-owned window'
    }
    $deadline = [DateTime]::UtcNow.AddSeconds(4)
    do {
      Start-Sleep -Milliseconds 50
      $owner = 0
      [void][VykorLiveCleanup]::GetWindowThreadProcessId($handle, [ref]$owner)
      if ($owner -ne $frame.Id) { return }
    } while ([DateTime]::UtcNow -lt $deadline)
    throw 'The test-owned window remained open after cleanup'
  `, {
    VYKOR_LIVE_APP_PID: String(window.applicationPid ?? window.pid),
    VYKOR_LIVE_APP_START: String(window.applicationStartKey ?? window.processStartKey),
    VYKOR_LIVE_WINDOW_PID: String(window.pid),
    VYKOR_LIVE_FRAME_START: String(window.processStartKey),
    VYKOR_LIVE_SESSION: String(window.sessionId),
    VYKOR_LIVE_HWND: String(window.windowId),
    VYKOR_LIVE_STARTED_AFTER: String(startedAfter),
  })
}

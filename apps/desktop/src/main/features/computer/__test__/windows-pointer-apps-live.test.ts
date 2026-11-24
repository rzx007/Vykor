import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import sharp from "sharp"
import type { ComputerAction, ComputerResult } from "@vykor/server/daemon-host"
import { expect, it } from "vitest"
import { ComputerHost } from "../computer-host"
import type { ComputerForegroundFrame } from "../computer-platform"
import type { WindowsAppWindow } from "../windows-apps"
import { createWindowsComputerPlatform } from "../windows-computer-platform"

const enabled = process.env.VYKOR_COMPUTER_WINDOWS_POINTER_LIVE === "1" && process.platform === "win32" && process.arch === "x64"
const system = process.env.SystemRoot ?? "C:\\Windows"
const powershell = join(system, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
const signal = () => AbortSignal.timeout(8_000)

type Control = { name: string; x: number; y: number; width: number; height: number; selected: boolean }

function inspectWindows(script: string, settings: Record<string, string>) {
  return execFileSync(powershell, ["-NoProfile", "-NonInteractive", "-STA", "-Command",
    "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.Encoding]::UTF8; " + script], {
    windowsHide: true, timeout: 10_000, encoding: "utf8", env: { ...process.env, ...settings },
  })
}

// UI Automation is an independent assertion source for the test. It never performs a gesture.
function controls(window: WindowsAppWindow): Control[] {
  return JSON.parse(inspectWindows(String.raw`
    Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes,WindowsBase
    for ($attempt = 0; $attempt -lt 4; $attempt++) {
      $root = [Windows.Automation.AutomationElement]::FromHandle([IntPtr][long]$env:VYKOR_POINTER_HWND)
      if ($root.Current.ProcessId -ne [int]$env:VYKOR_POINTER_PID) { throw 'Test target changed' }
      try {
        $rows = @($root.FindAll('Descendants', [Windows.Automation.Condition]::TrueCondition) | ForEach-Object {
          $row = $_.Current
          if (!$row.Name -or $row.IsOffscreen -or $row.BoundingRectangle.IsEmpty) { return }
          $pattern = $null
          $selected = $_.TryGetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pattern) -and $pattern.Current.IsSelected
          [pscustomobject]@{ name = $row.Name; x = $row.BoundingRectangle.X; y = $row.BoundingRectangle.Y;
            width = $row.BoundingRectangle.Width; height = $row.BoundingRectangle.Height; selected = $selected }
        })
        ConvertTo-Json -InputObject $rows -Compress
        return
      } catch {
        if ($attempt -eq 3 -or $_.FullyQualifiedErrorId -ne 'ElementNotAvailableException') { throw }
        Start-Sleep -Milliseconds 100
      }
    }
  `, { VYKOR_POINTER_HWND: `${window.windowId}`, VYKOR_POINTER_PID: `${window.pid}` }))
}

function cursorPosition(): { x: number; y: number } {
  return JSON.parse(inspectWindows(String.raw`
    Add-Type -AssemblyName System.Windows.Forms
    $p = [Windows.Forms.Cursor]::Position
    ConvertTo-Json -InputObject @{x=$p.X;y=$p.Y} -Compress
  `, {}))
}

function focusTestWindow(window: WindowsAppWindow) {
  inspectWindows(String.raw`
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -ReferencedAssemblies ([Windows.Forms.Control].Assembly.Location) -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;
public static class VykorPointerFixtureFocus {
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint current, uint foreground, bool attach);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    public static bool Focus(IntPtr hwnd, uint pid) {
        uint owner;
        if (GetWindowThreadProcessId(hwnd, out owner) == 0 || owner != pid) return false;
        using (var pump = new Control()) {
            var queue = pump.Handle;
            var current = GetCurrentThreadId();
            var foreground = GetWindowThreadProcessId(GetForegroundWindow(), out owner);
            bool attached = foreground != 0 && foreground != current && AttachThreadInput(current, foreground, true);
            try {
                SetForegroundWindow(hwnd);
                for (int i = 0; i < 10 && GetForegroundWindow() != hwnd; i++) { Application.DoEvents(); Thread.Sleep(20); }
                return GetForegroundWindow() == hwnd;
            } finally { if (attached) AttachThreadInput(current, foreground, false); }
        }
    }
}
'@
    if (![VykorPointerFixtureFocus]::Focus([IntPtr][long]$env:VYKOR_POINTER_HWND, [uint32]$env:VYKOR_POINTER_PID)) {
      throw 'Could not focus the test-owned window'
    }
  `, { VYKOR_POINTER_HWND: `${window.windowId}`, VYKOR_POINTER_PID: `${window.pid}` })
}

function closeOwnedPaint(window: WindowsAppWindow) {
  inspectWindows(String.raw`
    $p = Get-Process -Id ([int]$env:VYKOR_POINTER_PID) -ErrorAction SilentlyContinue
    if ($p -and $p.StartTime.ToFileTimeUtc().ToString() -eq $env:VYKOR_POINTER_STARTED -and $p.ProcessName -eq 'mspaint') {
      Stop-Process -Id $p.Id
    }
  `, { VYKOR_POINTER_PID: `${window.applicationPid}`, VYKOR_POINTER_STARTED: window.applicationStartKey ?? "" })
}

function fixture() {
  const platform = createWindowsComputerPlatform()
  const { apps, foreground: native } = platform
  const run = { sessionId: "pointer-live", runId: "pointer-run", inputId: "pointer-request" }
  const connection = new AbortController()
  let image: ComputerForegroundFrame | undefined
  let revoked: string | undefined
  const host = new ComputerHost({
    ...platform,
    foreground: {
      enter(window, notify, signal) {
        return native.enter(window, reason => { revoked = reason; notify(reason) }, signal)
      },
      async capture(...args) { image = await native.capture(...args); return image },
    },
  }, {
    authorizeApp: async () => true,
    chooseTarget: async () => { throw new Error("Expected a single test window") },
    showForeground: async () => {}, emergencyStop: () => {},
  })
  return {
    apps,
    async execute(action: ComputerAction): Promise<ComputerResult> {
      const result = await host.execute({ type: "execute", requestId: action.type, run, action, fullAccess: true,
        deadlineAt: Date.now() + 15_000 }, AbortSignal.timeout(15_000), connection.signal, undefined, async () => true)
      if ("error" in result) throw new Error(`${action.type}: ${result.error}${revoked ? ` (${revoked})` : ""}`)
      return result
    },
    async stop() { host.revoke(run.sessionId, run.runId); connection.abort(); expect(await host.waitForInputRelease()).toBe(true) },
    image: () => image!,
  }
}

function imagePoint(frame: ComputerForegroundFrame, x: number, y: number) {
  return { x: Math.floor((x - frame.geometry.left) * frame.width / frame.geometry.width),
    y: Math.floor((y - frame.geometry.top) * frame.height / frame.geometry.height) }
}

async function readFrame(f: ReturnType<typeof fixture>) {
  const reply = await f.execute({ type: "capture" })
  return { image: f.image(), frameRef: JSON.parse(reply.text).frame.ref as string }
}

async function darkPixels(frame: ComputerForegroundFrame) {
  const pixels = await sharp(Buffer.from(frame.data, "base64")).greyscale().raw().toBuffer()
  return pixels.reduce((count, value) => count + Number(value < 110), 0)
}

it.runIf(enabled)("draws a circle in Paint and reads it back in a native-resolution crop", async context => {
  const f = fixture()
  const [app] = await f.apps.discover("Paint", signal())
  expect(app).toBeDefined()
  if ((await f.apps.windows(app!, signal())).length) context.skip()
  const started = Date.now()
  let window: WindowsAppWindow | undefined
  try {
    await f.execute({ type: "open_app", app: "Paint" })
    window = (await f.apps.windows(app!, signal())).find(item => item.processStartedAt >= started)
    expect(window).toBeDefined()
    await f.execute({ type: "foreground" })
    const ellipse = controls(window!).find(row => /^(ellipse|oval|椭圆)$/iu.test(row.name))!
    expect(ellipse).toBeDefined()
    const toolbar = await readFrame(f)
    const center = { x: ellipse.x + ellipse.width / 2, y: ellipse.y + ellipse.height / 2 }
    const icon = imagePoint(toolbar.image, center.x, center.y)
    await f.execute({ type: "hover", frameRef: toolbar.frameRef, ...icon })
    const cursor = cursorPosition()
    expect(Math.abs(cursor.x - center.x)).toBeLessThanOrEqual(3)
    expect(Math.abs(cursor.y - center.y)).toBeLessThanOrEqual(3)
    const fresh = await readFrame(f)
    await f.execute({ type: "click", frameRef: fresh.frameRef, ...icon })
    const canvas = () => controls(window!).find(row => /(?:canvas|画布)/iu.test(row.name))
    await expect.poll(() => canvas()?.name).toMatch(/ellipse|oval|椭圆/iu)
    const base = await readFrame(f)
    const start = imagePoint(base.image, canvas()!.x + 150, canvas()!.y + 120)
    const end = imagePoint(base.image, canvas()!.x + 310, canvas()!.y + 280)
    const region = { x: start.x - 8, y: start.y - 8, width: end.x - start.x + 17, height: end.y - start.y + 17 }
    const before = await f.execute({ type: "capture", frameRef: base.frameRef, region })
    const crop = f.image()
    expect(crop.region).toBeDefined()
    expect(crop.width).toBe(crop.region?.width)
    expect(crop.height).toBe(crop.region?.height)
    expect(await darkPixels(crop)).toBeLessThan(10)
    const frameRef = JSON.parse(before.text).frame.ref
    const nativeStart = { x: Math.round((start.x - region.x) * crop.width / region.width), y: Math.round((start.y - region.y) * crop.height / region.height) }
    await f.execute({ type: "drag", frameRef, ...nativeStart,
      toX: Math.round((end.x - region.x) * crop.width / region.width), toY: Math.round((end.y - region.y) * crop.height / region.height) })
    const after = await readFrame(f)
    await f.execute({ type: "capture", frameRef: after.frameRef, region })
    expect(await darkPixels(f.image())).toBeGreaterThan(200)
  } finally {
    await f.stop()
    if (window) closeOwnedPaint(window)
  }
}, 100_000)

it.runIf(enabled)("selects with Ctrl and Shift, wheels, and double-clicks a folder in File Explorer", async () => {
  const f = fixture()
  const [app] = await f.apps.discover("File Explorer", signal())
  expect(app).toBeDefined()
  const directory = await mkdtemp(join(tmpdir(), "vykor-pointer-"))
  const names = Array.from({ length: 55 }, (_, index) => `${String(index + 1).padStart(2, "0")}-Pointer`)
  const [first, second, third] = names
  const setup = { VYKOR_POINTER_DIRECTORY: directory }
  let window: WindowsAppWindow | undefined
  try {
    await Promise.all(names.map(name => mkdir(join(directory, name))))
    inspectWindows("(New-Object -ComObject Shell.Application).Explore($env:VYKOR_POINTER_DIRECTORY)", setup)
    const find = async () => (await f.apps.windows(app!, signal())).find(item => item.document?.toLowerCase() === directory.toLowerCase())
    await expect.poll(find, { timeout: 15_000 }).toBeDefined()
    window = (await find())!
    await f.execute({ type: "open_app", app: "File Explorer", windowHint: directory })
    focusTestWindow(window)
    await f.execute({ type: "foreground" })
    const read = () => controls(window!).filter(row => names.includes(row.name))
    const selected = () => read().filter(row => row.selected).map(row => row.name).sort()
    const point = async (name: string) => {
      const row = read().find(item => item.name === name)!
      expect(row, `Expected ${name} to be visible`).toBeDefined()
      const { image, frameRef } = await readFrame(f)
      return { frameRef, ...imagePoint(image, row.x + Math.min(row.width / 2, 48), row.y + row.height / 2) }
    }
    await f.execute({ type: "click", ...await point(first!) })
    await f.execute({ type: "click", ...await point(third!), modifiers: ["ctrl"] })
    await expect.poll(selected).toEqual([first, third])
    await f.execute({ type: "click", ...await point(first!) })
    await f.execute({ type: "click", ...await point(third!), modifiers: ["shift"] })
    await expect.poll(selected).toEqual([first, second, third])
    const before = read().map(row => row.name)
    const wheel = await point(third!)
    await f.execute({ type: "scroll_at", ...wheel, direction: "down", amount: 4 })
    await expect.poll(() => read().map(row => row.name)).not.toEqual(before)
    const visible = read().filter(row => row.width > 1 && row.height > 1)
    const destination = visible[Math.floor(visible.length / 2)]!.name
    await f.execute({ type: "click", ...await point(destination), count: 2 })
    await expect.poll(async () => (await f.apps.windows(app!, signal())).find(item => item.windowId === window!.windowId)?.document,
      { timeout: 10_000 }).toBe(join(directory, destination))
  } finally {
    await f.stop()
    if (window) inspectWindows(String.raw`
      $shell = New-Object -ComObject Shell.Application
      foreach ($item in $shell.Windows()) {
        if ($item.HWND -ne [long]$env:VYKOR_POINTER_HWND) { continue }
        $uri = $null
        if (![Uri]::TryCreate([string]$item.LocationURL, [UriKind]::Absolute, [ref]$uri) -or !$uri.IsFile) { continue }
        $root = $env:VYKOR_POINTER_DIRECTORY
        if ($uri.LocalPath -eq $root -or $uri.LocalPath.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)) { $item.Quit() }
      }
    `, { ...setup, VYKOR_POINTER_HWND: `${window.windowId}` })
    await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })
  }
}, 120_000)

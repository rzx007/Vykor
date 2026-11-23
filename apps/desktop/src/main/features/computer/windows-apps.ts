import { execFile, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { realpath, stat } from "node:fs/promises"
import { win32 as path } from "node:path"
import { promisify } from "node:util"
import { windowsActivatePackagedApp, windowsWindowQuery } from "./windows-window-query"

export interface WindowsApp {
  id: string
  name: string
  builtIn?: "notepad"
  /** Local application chooser only. Never include native details in a model result. */
  detail?: string
}

export interface WindowsAppWindow {
  windowId: number
  ownerWindowId?: number
  pid: number
  processStartedAt: number
  /** Exact native creation time. Compare it as well as the displayed timestamp. */
  processStartKey?: string
  threadId?: number
  sessionId: number
  /** A blocked root has no safe dialog the host may inherit from this scan. */
  blocked?: boolean
  /** Packaged apps can be hosted inside a separate Windows frame process. */
  applicationPid?: number
  applicationStartKey?: string
  title: string
  document?: string
  /** Desktop chooser only. Input geometry is captured and verified separately. */
  position?: { left: number; top: number }
}

export interface WindowsApps {
  discover(name: string, signal: AbortSignal): Promise<WindowsApp[]>
  windows(app: WindowsApp, signal: AbortSignal): Promise<WindowsAppWindow[]>
  launch(app: WindowsApp, signal: AbortSignal): Promise<void>
}

export class WindowsAppUnavailableError extends Error {
  constructor(message: string, readonly reason: "desktop_unavailable" | "window_restricted" | "app_changed") {
    super(message)
  }
}

interface RegistryEntry {
  name: string
  registration: string
  target: string
}

interface ResolvedApp extends WindowsApp {
  registration: string
  executable?: string
  explorer: boolean
}

const run = promisify(execFile)
const explorerId = "microsoft.windows.explorer"
const packagedId = /^[a-z\d][a-z\d.-]*_[a-z\d]+![a-z\d][a-z\d.-]*$/i
const aliases = new Map<string, readonly string[]>([
  [explorerId, ["File Explorer", "Windows Explorer", "Explorer", "资源管理器", "文件资源管理器", "explorer.exe"]],
  ["microsoft.paint_8wekyb3d8bbwe!app", ["Paint", "MS Paint", "画图", "mspaint.exe"]],
  ["microsoft.windowsnotepad_8wekyb3d8bbwe!app", ["Notepad", "记事本", "notepad.exe"]],
  ["microsoft.windowscalculator_8wekyb3d8bbwe!app", ["Calculator", "计算器", "calc", "calc.exe"]],
])

const catalogScript = String.raw`
$shell = New-Object -ComObject Shell.Application
$folder = $shell.Namespace('shell:AppsFolder')
if (!$folder) { throw 'The Windows application catalog is unavailable.' }
$catalog = @(
  foreach ($entry in $folder.Items()) {
    $registration = $entry.ExtendedProperty('System.AppUserModel.ID')
    if (!$registration) { $registration = $entry.Path }
    $target = $entry.ExtendedProperty('System.Link.TargetParsingPath')
    [pscustomobject]@{ name = [string]$entry.Name; registration = [string]$registration; target = [string]$target }
  }
)
ConvertTo-Json -InputObject $catalog -Compress
`

const windowScript = String.raw`
Add-Type -TypeDefinition $env:VYKOR_COMPUTER_WINDOW_CODE
$scan = [VykorWindowsWindowQuery]::Scan(
  $env:VYKOR_COMPUTER_APP_REGISTRATION, $env:VYKOR_COMPUTER_APP_EXECUTABLE,
  $env:VYKOR_COMPUTER_FRAME_IMAGE, ($env:VYKOR_COMPUTER_APP_EXPLORER -eq '1'))
if ($env:VYKOR_COMPUTER_APP_EXPLORER -eq '1' -and $scan.windows.Count) {
  $shell = New-Object -ComObject Shell.Application
  foreach ($shellWindow in $shell.Windows()) {
    try {
      $window = $scan.windows | Where-Object { $_.windowId -eq $shellWindow.HWND } | Select-Object -First 1
      $uri = $null
      if ($window -and [Uri]::TryCreate([string]$shellWindow.LocationURL, [UriKind]::Absolute, [ref]$uri) -and $uri.IsFile) {
        $window.document = $uri.LocalPath
      }
    } catch { continue }
  }
}
ConvertTo-Json -InputObject $scan -Depth 4 -Compress
`

const activateScript = String.raw`
Add-Type -TypeDefinition $env:VYKOR_COMPUTER_ACTIVATE_CODE
[VykorPackagedApp]::Activate($env:VYKOR_COMPUTER_APP_REGISTRATION)
`

function normalized(text: string): string {
  return text.trim().normalize("NFKC").toLowerCase()
}

function applicationNames(entry: RegistryEntry): string[] {
  const executable = path.basename(entry.target)
  const filename = /\.exe$/i.test(executable) ? executable : ""
  return [
    entry.name,
    ...(aliases.get(normalized(entry.registration)) ?? []),
    ...(filename ? [filename, filename.slice(0, -4)] : []),
  ].map(normalized)
}

function isUsableEntry(value: unknown): value is RegistryEntry {
  if (!value || typeof value !== "object") return false
  const entry = value as Partial<RegistryEntry>
  return typeof entry.name === "string" && entry.name.trim().length > 0 && entry.name.length <= 256 &&
    typeof entry.registration === "string" && entry.registration.trim().length > 0 && entry.registration.length <= 512 &&
    typeof entry.target === "string"
}

function isUsableWindow(value: unknown): value is WindowsAppWindow {
  if (!value || typeof value !== "object") return false
  const window = value as Partial<WindowsAppWindow>
  return [window.windowId, window.pid, window.threadId, window.sessionId, window.processStartedAt, window.applicationPid]
    .every(field => Number.isSafeInteger(field) && Number(field) > 0) &&
    typeof window.processStartKey === "string" && /^\d+$/.test(window.processStartKey) &&
    typeof window.applicationStartKey === "string" && /^\d+$/.test(window.applicationStartKey) &&
    typeof window.title === "string" && window.title.trim().length > 0
}

function isLocalExecutable(candidate: string): boolean {
  return /^[a-z]:[/\\]/i.test(candidate) && /\.exe$/i.test(candidate) && !candidate.includes("\x00")
}

async function classicAppId(registration: string, executable: string): Promise<string | undefined> {
  try {
    const file = await stat(executable, { bigint: true })
    if (!file.isFile()) return
    return createHash("sha256").update(JSON.stringify([
      "desktop", normalized(registration), normalized(executable),
      String(file.ino), String(file.birthtimeNs), String(file.mtimeNs), String(file.size),
    ])).digest("hex")
  } catch {
    return
  }
}

async function resolveEntry(entry: RegistryEntry, systemRoot: string): Promise<ResolvedApp | undefined> {
  const registration = entry.registration.trim()
  const explorer = normalized(registration) === explorerId
  const digest = createHash("sha256")
  if (packagedId.test(registration) && !explorer) {
    return { id: digest.update("package:" + normalized(registration)).digest("hex"), name: entry.name, registration, explorer }
  }
  const target = explorer ? path.join(systemRoot, "explorer.exe") : entry.target
  if (!isLocalExecutable(target)) return
  try {
    const executable = await realpath(target)
    if (!isLocalExecutable(executable)) return
    const id = await classicAppId(registration, executable)
    if (!id) return
    return { id, name: entry.name, registration, executable, explorer }
  } catch {
    // A stale or unreachable Start menu registration is not a launch candidate.
    return
  }
}

function localLaunch(executable: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  return new Promise((success, fail) => {
    const child = spawn(executable, [], {
      cwd: path.dirname(executable), detached: true, windowsHide: false, stdio: "ignore", shell: false,
    })
    child.once("error", fail)
    child.once("spawn", () => { child.unref(); success() })
  })
}

export function createWindowsApps(): WindowsApps {
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows"
  const system32 = path.join(systemRoot, "System32")
  const powershell = path.join(system32, "WindowsPowerShell", "v1.0", "powershell.exe")
  const issued = new WeakMap<WindowsApp, ResolvedApp>()

  const runPowerShell = async (script: string, env: Record<string, string>, signal: AbortSignal): Promise<string> => {
    signal.throwIfAborted()
    const { stdout } = await run(powershell, [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-Command",
      "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); " + script,
    ], {
      env: { ...process.env, ...env }, signal, encoding: "utf8", windowsHide: true, timeout: 7_000, maxBuffer: 1024 * 1024,
    })
    return stdout.trim()
  }
  const catalog = async (signal: AbortSignal): Promise<RegistryEntry[]> => {
    const value = JSON.parse(await runPowerShell(catalogScript, {}, signal)) as unknown
    if (!Array.isArray(value)) throw new Error("Windows returned an invalid application catalog")
    return value.filter(isUsableEntry)
  }
  const resolved = (app: WindowsApp): ResolvedApp => {
    const known = issued.get(app)
    if (!known) throw new WindowsAppUnavailableError("This Windows application reference is no longer available.", "app_changed")
    return known
  }
  const assertExecutable = async (known: ResolvedApp): Promise<void> => {
    if (known.executable && await classicAppId(known.registration, known.executable) !== known.id) {
      throw new WindowsAppUnavailableError("The Windows application changed after it was selected.", "app_changed")
    }
  }
  return {
    async discover(name, signal) {
      const query = normalized(name)
      if (!query || query.length > 160) return []
      const entries = await catalog(signal)
      const exact = entries.filter(entry => applicationNames(entry).includes(query))
      const candidates = exact.length ? exact : entries.filter(entry => applicationNames(entry).some(alias => alias.includes(query)))
      const apps = new Map<string, WindowsApp>()
      for (const candidate of candidates) {
        signal.throwIfAborted()
        const known = await resolveEntry(candidate, systemRoot)
        if (!known || apps.has(known.id)) continue
        const app: WindowsApp = Object.freeze({
          id: known.id, name: known.name, detail: known.executable ?? known.registration,
          ...(normalized(known.registration) === "microsoft.windowsnotepad_8wekyb3d8bbwe!app" && !known.executable
            ? { builtIn: "notepad" as const } : {}),
        })
        issued.set(app, known)
        apps.set(app.id, app)
      }
      return [...apps.values()].sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
    },
    async windows(app, signal) {
      const known = resolved(app)
      await assertExecutable(known)
      const result = JSON.parse(await runPowerShell(windowScript, {
        VYKOR_COMPUTER_WINDOW_CODE: windowsWindowQuery,
        VYKOR_COMPUTER_APP_REGISTRATION: known.registration,
        VYKOR_COMPUTER_APP_EXECUTABLE: known.executable ?? "",
        VYKOR_COMPUTER_FRAME_IMAGE: path.join(system32, "ApplicationFrameHost.exe"),
        VYKOR_COMPUTER_APP_EXPLORER: known.explorer ? "1" : "0",
      }, signal)) as { desktopAvailable?: boolean; restricted?: boolean; windows?: unknown[] }
      if (!result.desktopAvailable) {
        throw new WindowsAppUnavailableError("The Windows desktop is locked or unavailable.", "desktop_unavailable")
      }
      await assertExecutable(known)
      if (!Array.isArray(result.windows)) throw new Error("Windows returned an invalid window inventory")
      const windows = result.windows.filter(isUsableWindow).map(window => ({
        windowId: window.windowId,
        pid: window.pid,
        sessionId: window.sessionId,
        processStartedAt: window.processStartedAt,
        processStartKey: window.processStartKey,
        threadId: window.threadId,
        applicationPid: window.applicationPid,
        applicationStartKey: window.applicationStartKey,
        title: window.title,
        ...(window.blocked === true ? { blocked: true } : {}),
        ...(Number.isSafeInteger(window.ownerWindowId) ? { ownerWindowId: window.ownerWindowId } : {}),
        ...(typeof window.document === "string" && window.document.length <= 1024 ? { document: window.document } : {}),
        ...(window.position && Number.isSafeInteger(window.position.left) && Number.isSafeInteger(window.position.top)
          ? { position: { left: window.position.left, top: window.position.top } } : {}),
      }))
      if (!windows.length && result.restricted) {
        throw new WindowsAppUnavailableError("Windows restricts access to this application's window.", "window_restricted")
      }
      return windows
    },
    async launch(app, signal) {
      const known = resolved(app)
      // Re-resolve by its original registration after the user has granted permission.
      const currentEntries = (await catalog(signal)).filter(entry =>
        normalized(entry.registration) === normalized(known.registration))
      const current = await Promise.all(currentEntries.map(entry => resolveEntry(entry, systemRoot)))
      if (!current.some(candidate => candidate?.id === known.id)) {
        throw new WindowsAppUnavailableError("The Windows application changed after it was selected.", "app_changed")
      }
      if (known.executable) {
        await localLaunch(known.executable, signal)
      } else {
        await runPowerShell(activateScript, {
          VYKOR_COMPUTER_ACTIVATE_CODE: windowsActivatePackagedApp,
          VYKOR_COMPUTER_APP_REGISTRATION: known.registration,
        }, signal)
      }
    },
  }
}

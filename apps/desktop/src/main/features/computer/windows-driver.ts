/// <reference types="vite/client" />
import { execFile } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join } from "node:path"
import { isDeepStrictEqual, promisify } from "node:util"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import release from "../../../../resources/computer-windows/driver-release.json"
import bundledLicense from "../../../../resources/computer-windows/CUA-LICENSE.txt?raw"
import {
  ComputerDriverError, ComputerDriverHandoffError,
  type ComputerDriver, type ComputerDriverAction, type ComputerDriverElement,
} from "./computer-platform"
import type { WindowsAppWindow } from "./windows-apps"
import { windowsSemanticQuery } from "./windows-semantic-query"

interface Frame { x: number; y: number; w: number; h: number }

interface NativeRow extends Omit<ComputerDriverElement, "token" | "checked" | "identity"> {
  identity: string
  frame?: Frame | null
  checkedState?: boolean
}

const handoffReason = "请在 Windows 中处理身份验证或受保护界面，再回到聊天继续。"
const privateLabel = /password|passcode|credential|recovery (?:phrase|key|code)|one.time code|otp code|密码|口令|验证码|助记词|恢复(?:码|密钥)/iu

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

function sameFrame(native: Frame | null | undefined, candidate: unknown): boolean {
  const frame = record(candidate)
  return !!native && !!frame && native.w > 0 && native.h > 0 &&
    (["x", "y", "w", "h"] as const).every(key => typeof frame[key] === "number" && Math.abs(frame[key] - native[key]) <= 1)
}

/** Keep only controls proved to be descendants of the exact HWND by Windows UI Automation. */
export function bindWindowsElements(native: NativeRow[], upstream: unknown[]): NativeRow[] {
  const cua = upstream.map(record).filter(row => row !== undefined)
  return native.filter(row => !row.protected && !privateLabel.test(row.label)).map(row => {
    const candidates = cua.filter(candidate => candidate.role === row.role && (candidate.label ?? "") === row.label
      && sameFrame(row.frame, candidate.frame))
    const match = candidates.length === 1 && native.filter(other => other.role === row.role && other.label === row.label
      && sameFrame(other.frame, candidates[0]?.frame)).length === 1 ? candidates[0] : undefined
    // Cua can also report a same-PID sibling. Its facts may restrict an action,
    // while only the native window's row supplies authority or field content.
    const enabled = row.enabled && match?.enabled !== false
    return {
      ...row, enabled, value: row.valueDigest ? row.value ?? undefined : undefined, valueDigest: row.valueDigest ?? undefined,
      actions: row.actions.filter(action => enabled && (action !== "set_value" || Boolean(row.valueDigest))),
    }
  })
}

const run = promisify(execFile)

function powershell(script: string, env: Record<string, string>, signal: AbortSignal): Promise<string> {
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows"
  const executable = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
  return run(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-Command",
    "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); " + script], {
    env: { ...process.env, ...env }, signal, encoding: "utf8", windowsHide: true, timeout: 10_000, maxBuffer: 1024 * 1024,
  }).then(result => result.stdout.trim())
}

const nativeScript = String.raw`
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes,WindowsBase
$references = @([System.Windows.Automation.AutomationElement].Assembly.Location,
  [System.Windows.Automation.AutomationElementIdentifiers].Assembly.Location, [System.Windows.Rect].Assembly.Location)
Add-Type -ReferencedAssemblies $references -TypeDefinition @'
${windowsSemanticQuery}
'@
$q = $env:VYKOR_CUA_NATIVE_REQUEST | ConvertFrom-Json
$result = [VykorWindowsSemanticQuery]::Run($q.hwnd, $q.owner, $q.pid, $q.thread, $q.session, $q.started, $q.app, $q.appStarted,
  $q.operation, $q.identity, $q.role, $q.label, $q.automationId, $q.direction, $q.amount, $q.oldValueDigest, $q.text, $q.title)
ConvertTo-Json -InputObject $result -Depth 6 -Compress
`

function nativeQuery(window: WindowsAppWindow, signal: AbortSignal, control?: NativeRow, action?: ComputerDriverAction): Promise<unknown> {
  const request = {
    hwnd: window.windowId, owner: window.ownerWindowId ?? 0, pid: window.pid, thread: window.threadId ?? 0, session: window.sessionId,
    started: window.processStartKey, app: window.applicationPid ?? window.pid, appStarted: window.applicationStartKey ?? "",
    operation: action?.type ?? "observe", identity: control?.identity ?? "", role: control?.role ?? "", label: control?.label ?? "",
    automationId: control?.automationId ?? "",
    direction: action?.type === "scroll" ? action.direction : "", amount: action?.type === "scroll" ? action.amount ?? 1 : 1,
    oldValueDigest: control?.valueDigest ?? "", text: action?.type === "set_text" ? action.text : "", title: window.title,
  }
  return powershell(nativeScript, { VYKOR_CUA_NATIVE_REQUEST: JSON.stringify(request) }, signal).then(JSON.parse)
}

const authenticodeScript = String.raw`
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1')
$signature = Get-AuthenticodeSignature -LiteralPath $env:VYKOR_CUA_VERIFY_FILE
if ($signature.Status -eq 'Valid' -and $signature.SignerCertificate) {
  $signature.SignerCertificate.GetNameInfo('SimpleName', $false)
}
`

async function bundledDriverDirectory(): Promise<string> {
  const { app } = await import("electron")
  return app.isPackaged ? join(process.resourcesPath, "computer-windows")
    : join(app.getAppPath(), "out", "computer-windows", "x64")
}

async function readVerifiedDriver(source: string, signal?: AbortSignal): Promise<Buffer> {
  const bytes = await readFile(source, { signal })
  if (createHash("sha256").update(bytes).digest("hex") !== release.executableSha256) {
    throw new ComputerDriverError("Windows 控制驱动的校验值不符。")
  }
  return bytes
}

export async function assertBundledWindowsDriverIntegrity(signal?: AbortSignal): Promise<void> {
  try {
    const directory = await bundledDriverDirectory()
    const [manifest, license] = await Promise.all([
      readFile(join(directory, "driver-release.json"), { encoding: "utf8", signal }),
      readFile(join(directory, "CUA-LICENSE.txt"), { encoding: "utf8", signal }),
      readVerifiedDriver(join(directory, release.executable), signal),
    ])
    if (!isDeepStrictEqual(JSON.parse(manifest), release) || license !== bundledLicense)
      throw new ComputerDriverError("Windows 控制驱动的发布清单或许可证不符。")
  } catch (error) {
    signal?.throwIfAborted()
    throw error instanceof ComputerDriverError ? error : new ComputerDriverError("电脑操作驱动无法读取。请重新安装经过核验的版本。")
  }
}

async function prepareExecutable(source: string, directory: string, signal: AbortSignal): Promise<string> {
  const bytes = await readVerifiedDriver(source, signal)
  // Execute only the bytes verified in this session's private directory.
  const executable = join(directory, release.executable)
  await writeFile(executable, bytes, { flag: "wx", signal })
  if (await powershell(authenticodeScript, { VYKOR_CUA_VERIFY_FILE: executable }, signal) !== release.publisher) {
    throw new ComputerDriverError("Windows 控制驱动的发布者签名验证失败。")
  }
  return executable
}

class OwnedTransport extends StdioClientTransport {
  private closing?: Promise<void>

  override close(): Promise<void> {
    return this.closing ??= super.close()
  }
}

const tools = ["start_session", "get_window_state"] as const
type Tool = (typeof tools)[number]

export async function createWindowsDriver(window: WindowsAppWindow, signal: AbortSignal, source?: string): Promise<ComputerDriver> {
  signal.throwIfAborted()
  if (process.platform !== "win32" || process.arch !== "x64") throw new ComputerDriverError("Windows 控制驱动当前需要 Windows x64。")
  if (!Number.isSafeInteger(window.pid) || window.pid <= 0 || !Number.isSafeInteger(window.windowId) || window.windowId <= 0
    || !/^\d+$/u.test(window.processStartKey ?? "") || window.blocked) {
    throw new ComputerDriverError("无法确认 Windows 窗口的身份。")
  }
  source ??= join(await bundledDriverDirectory(), release.executable)
  if (!isAbsolute(source)) throw new ComputerDriverError("Windows 控制驱动的安装路径无效。")
  const directory = await mkdtemp(join(tmpdir(), "vykor-cua-"))
  const session = "vykor-control"
  const scope = { pid: window.pid, window_id: window.windowId }
  const controls = new Map<string, NativeRow>()
  const lifetime = new AbortController()
  const client = new Client({ name: "vykor-windows-controls", version: "1.0.0" })
  let transport: OwnedTransport | undefined
  let closing: Promise<void> | undefined
  const close = (): Promise<void> => closing ??= (async () => {
    controls.clear()
    lifetime.abort()
    try {
      await transport?.close()
    } finally {
      await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    }
  })()

  const call = async (name: Tool, args: Record<string, unknown>, operationSignal: AbortSignal): Promise<Record<string, unknown> | undefined> => {
    operationSignal.throwIfAborted()
    const result = await client.callTool({ name, arguments: { session, ...args } }, undefined, { signal: operationSignal, timeout: 12_000 })
    if (result.isError) throw new ComputerDriverError("Windows 控制驱动拒绝了本次请求。")
    return record(result.structuredContent)
  }

  function during<T>(operationSignal: AbortSignal, work: (active: AbortSignal) => Promise<T>): Promise<T> {
    const active = AbortSignal.any([lifetime.signal, operationSignal])
    active.throwIfAborted()
    const stop = (): void => { void close().catch(() => undefined) }
    operationSignal.addEventListener("abort", stop, { once: true })
    return work(active).finally(() => operationSignal.removeEventListener("abort", stop))
  }

  try {
    const executable = await prepareExecutable(source, directory, signal)
    const manifest = join(directory, "bounded.yaml")
    await writeFile(manifest, ["version: 3", "expires_after: 2m", "idle_timeout: 30s", "allow:",
      `  tools: [${tools.join(", ")}]`, "resources:", "  desktop:", "    display: false", "    windows:",
      `      - pid: ${scope.pid}`, `        window_id: ${scope.window_id}`, ""].join("\n"), { flag: "wx", signal })
    transport = new OwnedTransport({ command: executable, args: ["mcp", "--direct"], cwd: directory, stderr: "ignore", env: {
      LOCALAPPDATA: directory, APPDATA: directory, USERPROFILE: directory, TEMP: directory, TMP: directory,
      CUA_DRIVER_TELEMETRY_HOME: directory, CUA_DRIVER_RS_TELEMETRY_ENABLED: "0", CUA_DRIVER_RS_UPDATE_CHECK: "0",
      CUA_DRIVER_PERMISSION_MODE: "bounded", CUA_DRIVER_CAPABILITY_MANIFEST_FILE: manifest, CUA_DRIVER_CAPABILITY_MANIFEST_APPROVED: "1",
    } })
    await client.connect(transport, { signal, timeout: 10_000 })
    if (client.getServerVersion()?.version !== release.version) throw new ComputerDriverError("Windows 控制驱动版本不符。")
    await call("start_session", {}, signal)
  } catch (error) {
    await close().catch(() => undefined)
    signal.throwIfAborted()
    throw error instanceof ComputerDriverError ? error : new ComputerDriverError("无法启动已签名的 Windows 控制驱动。")
  }

  return {
    close,
    observe(operationSignal, readback) {
      return during(operationSignal, async active => {
        controls.clear()
        try {
          const title = readback?.title ?? window.title
          const observation = await nativeQuery({ ...window, title }, active)
          if (observation === "handoff") throw new ComputerDriverHandoffError(handoffReason)
          const native = record(observation)
          if (!Array.isArray(native?.rows)) throw new ComputerDriverError("无法读取已授权窗口内的控件。")
          let upstream: unknown[] = []
          // A post-dispatch readback uses the exact native target rechecked by the host.
          // The next dispatch checks the upstream scope again before handing out an input token.
          if (!readback) {
            const state = await call("get_window_state", { ...scope, include_screenshot: false, max_elements: 240, max_depth: 16 }, active)
            if (state?.window_id !== scope.window_id || state.pid !== scope.pid || !Array.isArray(state.elements) || state.degraded) {
              throw new ComputerDriverError("无法确认 Windows 控件来自已授权窗口。")
            }
            upstream = state.elements
          }
          active.throwIfAborted()
          const elements = bindWindowsElements(native.rows as NativeRow[], upstream).map(row => {
            const token = randomUUID()
            controls.set(token, row)
            const { frame: _frame, checkedState, selected, expanded,
              parentIndex, horizontalScrollPercent, verticalScrollPercent, ...facts } = row
            return { token, ...facts, checked: checkedState ?? undefined, selected: selected ?? undefined,
              expanded: expanded ?? undefined, parentIndex: parentIndex ?? undefined,
              horizontalScrollPercent: horizontalScrollPercent ?? undefined, verticalScrollPercent: verticalScrollPercent ?? undefined }
          })
          return { title, elements,
            focusIdentity: typeof native.focusIdentity === "string" && elements.some(row => row.identity === native.focusIdentity)
              ? native.focusIdentity : undefined }
        } catch (error) {
          active.throwIfAborted()
          throw error instanceof ComputerDriverError ? error : new ComputerDriverError("读取 Windows 控件失败。")
        }
      })
    },
    act(action, operationSignal) {
      return during(operationSignal, async active => {
        const control = controls.get(action.token)
        controls.clear()
        if (!control?.enabled) throw new ComputerDriverError("控件已变更，请重新观察窗口。")
        if (action.type === "set_text" && !control.actions.includes("set_value")) {
          throw new ComputerDriverError("此控件未提供可验证的文字写入能力。")
        }
        const status = await nativeQuery(window, active, control, action).catch(() => "unknown")
        if (status === "sent") return
        if (status === "handoff") throw new ComputerDriverHandoffError(handoffReason)
        if (status === "refused") throw new ComputerDriverError("该控件已变更或不支持此操作。")
        throw new ComputerDriverError("无法确认 Windows 操作结果。", "unknown")
      })
    },
  }
}

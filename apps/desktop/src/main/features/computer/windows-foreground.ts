import { spawn } from "node:child_process"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { setTimeout as delay } from "node:timers/promises"
import type { WindowsAppWindow } from "./windows-apps"
import { windowsForegroundQuery } from "./windows-foreground-query"

export type WindowsForegroundAction =
  | { type: "click"; x: number; y: number; button?: "left" | "right" }
  | { type: "key"; key: string; modifiers?: ("ctrl" | "alt" | "shift")[]; focusIdentity?: string }
  | { type: "text"; text: string; focusIdentity?: string }

export interface WindowsForegroundFrame {
  mimeType: "image/png"
  data: string
  width: number
  height: number
  geometry: { left: number; top: number; width: number; height: number; dpi: number; monitor: string }
  signature?: string
  focusIdentity?: string
}

export type WindowsForegroundRevokeReason = "focus_lost" | "physical_input" | "emergency_stop" |
  "window_changed" | "desktop_unavailable" | "driver_lost" | "release_unverified"

export interface WindowsForegroundRelease { released: boolean; exited: boolean }
export interface WindowsForegroundResult { state: "sent" | "refused" | "unknown"; released: boolean }
export interface WindowsForegroundLease {
  perform(action: WindowsForegroundAction, frame: WindowsForegroundFrame | undefined, signal: AbortSignal): Promise<WindowsForegroundResult>
  release(): Promise<WindowsForegroundRelease>
}
export interface WindowsForeground {
  capture(window: WindowsAppWindow, signal: AbortSignal): Promise<WindowsForegroundFrame>
  enter(window: WindowsAppWindow, onRevoked: (reason: WindowsForegroundRevokeReason) => void, signal: AbortSignal): Promise<WindowsForegroundLease>
}

const virtualKeys: Record<string, number> = {
  backspace: 8, tab: 9, enter: 13, escape: 27, space: 32, pageup: 33, pagedown: 34,
  end: 35, home: 36, left: 37, up: 38, right: 39, down: 40, insert: 45, delete: 46,
  arrowleft: 37, arrowup: 38, arrowright: 39, arrowdown: 40,
}
const modifiers = { ctrl: 17, alt: 18, shift: 16 }
const pinnedDownKeys = new Set([16, 17, 18])

/** Convert model-visible pixels to physical coordinates in the original capture. */
export function foregroundInput(action: WindowsForegroundAction, frame?: WindowsForegroundFrame) {
  if (action.type === "click") {
    if (!frame?.geometry.monitor || !frame.signature || !Number.isSafeInteger(action.x) || !Number.isSafeInteger(action.y) ||
        action.x < 0 || action.y < 0 || action.x >= frame.width || action.y >= frame.height) return
    const { left, top, width, height } = frame.geometry
    return {
      type: action.type, x: left + Math.floor(action.x * width / frame.width),
      y: top + Math.floor(action.y * height / frame.height), button: action.button ?? "left", geometry: frame.geometry,
      signature: frame.signature,
    }
  }
  const { focusIdentity } = action
  if (!focusIdentity) return
  if (action.type === "text") {
    if (!action.text || action.text.length > 1000 || /\p{Cc}/u.test(action.text)) return
    return { type: action.type, text: action.text, focusIdentity }
  }
  const name = action.key.trim().toLowerCase().replace(/[\s_-]/gu, "")
  const key = /^[a-z0-9]$/u.test(name) ? name.toUpperCase().charCodeAt(0)
    : /^f(?:[1-9]|1[0-2])$/u.test(name) ? 111 + Number(name.slice(1)) : virtualKeys[name]
  const chord = [...new Set(action.modifiers ?? [])]
  if (!key || pinnedDownKeys.has(key) || chord.some(modifier => !Object.hasOwn(modifiers, modifier)) ||
      (chord.includes("alt") && (chord.includes("ctrl") || [9, 27, 32, 115].includes(key))) ||
      (chord.includes("ctrl") && key === 27)) return
  return { type: action.type, key, modifiers: chord.map(modifier => modifiers[modifier]), focusIdentity }
}

const nativeScript = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$assemblies = 'System.Drawing', 'System.Windows.Forms', 'System.Web.Extensions', 'UIAutomationClient', 'UIAutomationTypes', 'WindowsBase'
Add-Type -AssemblyName $assemblies
$references = @([System.Drawing.Bitmap].Assembly.Location, [System.Windows.Forms.Application].Assembly.Location,
  [System.Web.Script.Serialization.JavaScriptSerializer].Assembly.Location, [System.Windows.Automation.AutomationElement].Assembly.Location,
  [System.Windows.Automation.AutomationElementIdentifiers].Assembly.Location, [System.Windows.Point].Assembly.Location)
Add-Type -ReferencedAssemblies $references -TypeDefinition $env:VYKOR_FOREGROUND_SOURCE
[VykorWindowsForeground]::Run($env:VYKOR_FOREGROUND_COMMAND, $env:VYKOR_FOREGROUND_WINDOW, $env:VYKOR_FOREGROUND_TEST_FAULT)
`

function windowIdentity(window: WindowsAppWindow): string {
  if (process.platform !== "win32" || process.arch !== "x64" || window.blocked ||
      !Number.isSafeInteger(window.windowId) || window.windowId <= 0 ||
      !window.processStartKey || !window.applicationStartKey || !window.threadId || !window.applicationPid) {
    throw new Error("当前 Windows 窗口无法用于截图或前台操作。")
  }
  return JSON.stringify({ hwnd: window.windowId, owner: window.ownerWindowId ?? 0, pid: window.pid, thread: window.threadId,
    started: window.processStartKey, session: window.sessionId, app: window.applicationPid,
    appStarted: window.applicationStartKey, title: window.title })
}

type NativeReply = {
  event?: "prepared" | "ready" | "revoked" | "released" | "frame" | "unavailable" | "test-held"
  upQueued?: boolean
  reason?: WindowsForegroundRevokeReason
  id?: number
  state?: WindowsForegroundResult["state"]
  released?: boolean
  frame?: WindowsForegroundFrame
}

type ForegroundFixtureGate = {
  fault: "lost-keyboard" | "hold-release" | "hold-activate"
  onHeld?: (upQueued: boolean) => void
  onPrepared?: () => void
}

export class WindowsForegroundStartError extends Error {
  constructor(message: string, readonly cleanup: WindowsForegroundRelease) {
    super(message)
  }
}

function startNative(command: "capture" | "enter", window: WindowsAppWindow, onReply: (reply: NativeReply) => void, fault = "") {
  const shell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
  const child = spawn(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-Command", nativeScript], {
    windowsHide: true, stdio: ["pipe", "pipe", "ignore"],
    env: { ...process.env, VYKOR_FOREGROUND_COMMAND: command, VYKOR_FOREGROUND_WINDOW: windowIdentity(window),
      VYKOR_FOREGROUND_SOURCE: windowsForegroundQuery, VYKOR_FOREGROUND_TEST_FAULT: fault },
  })
  const reader = createInterface({ input: child.stdout })
  reader.on("line", (line) => {
    if (line.length > 1_500_000) return
    let reply: NativeReply
    try { reply = JSON.parse(line) as NativeReply } catch { return }
    if (reply && typeof reply === "object") onReply(reply)
  })
  child.stdin.on("error", () => {})
  const exited = new Promise<boolean>((resolve) => {
    child.once("error", () => resolve(false))
    child.once("close", () => { reader.close(); resolve(true) })
  })
  return { child, exited }
}

const notStarted: WindowsForegroundResult = { state: "refused", released: true }

export function createWindowsForeground(fixture?: ForegroundFixtureGate): WindowsForeground {
  let occupied = false
  let releaseUnverified = false
  return {
    async capture(window, signal) {
      signal.throwIfAborted()
      let result: WindowsForegroundFrame | undefined
      const native = startNative("capture", window, reply => { if (reply.event === "frame") result = reply.frame })
      const captureSignal = AbortSignal.any([signal, AbortSignal.timeout(7_000)])
      const stop = () => { native.child.kill() }
      captureSignal.addEventListener("abort", stop, { once: true })
      try {
        await native.exited
        captureSignal.throwIfAborted()
        if (!result) throw new Error("无法获取这一个窗口的截图。")
        return result
      } finally { captureSignal.removeEventListener("abort", stop) }
    },
    async enter(window, onRevoked, signal) {
      signal.throwIfAborted()
      if (occupied || releaseUnverified) throw new Error("上一次前台输入的释放尚未确认。")
      occupied = true
      let ready = false
      let revoked = false
      let acknowledged = false
      let closing: Promise<WindowsForegroundRelease> | undefined
      let nextId = 0
      let pending: { id: number; finish: (result: WindowsForegroundResult) => void } | undefined
      const started = Promise.withResolvers<boolean>()
      function revoke(reason: WindowsForegroundRevokeReason) {
        if (revoked || closing) return
        revoked = true
        try { onRevoked(reason) }
        finally { void release() }
      }
      let native: ReturnType<typeof startNative>
      try {
        native = startNative("enter", window, reply => {
          if (reply.event === "prepared" && !signal.aborted && !closing) {
            if (fixture?.fault === "hold-activate") fixture.onPrepared?.()
            else native.child.stdin.write('{"type":"activate"}\n')
          }
          else if (reply.event === "ready") { ready = true; started.resolve(true) }
          else if (reply.event === "unavailable") started.resolve(false)
          else if (reply.event === "revoked" && reply.reason) revoke(reply.reason)
          else if (reply.event === "released") acknowledged = reply.released === true
          else if (reply.event === "test-held" && fixture) fixture.onHeld?.(reply.upQueued !== false)
          else if (pending && reply.id === pending.id && reply.state) pending.finish({ state: reply.state, released: reply.released === true })
        }, fixture?.fault)
      } catch (error) {
        occupied = false
        throw error
      }
      const abort = () => { void release() }
      const release = () => closing ??= (async () => {
        revoked = true
        native.child.stdin.end('{"type":"release"}\n')
        let exited = await Promise.race([native.exited, delay(2_500, false, { ref: false })])
        if (!exited) {
          native.child.kill()
          exited = await Promise.race([native.exited, delay(1_000, false, { ref: false })])
        }
        const released = acknowledged || (!ready && !pending)
        pending?.finish({ state: "unknown", released })
        releaseUnverified ||= !released || !exited
        occupied = false
        signal.removeEventListener("abort", abort)
        return { released, exited }
      })()
      signal.addEventListener("abort", abort, { once: true })
      void native.exited.then(() => { started.resolve(false); if (ready) revoke("driver_lost") })
      try {
        if (!await Promise.race([started.promise, delay(7_000, false, { ref: false })]) || signal.aborted) {
          throw new Error("无法接管目标窗口的前台输入。请切到该窗口后重试。")
        }
      } catch (error) {
        const cleanup = await release()
        if (!cleanup.released || !cleanup.exited) throw new WindowsForegroundStartError("无法确认前台助手已经退出。", cleanup)
        signal.throwIfAborted()
        throw error
      }
      return {
        async perform(action, frame, active) {
          active.throwIfAborted()
          if (revoked) return { state: "refused", released: closing ? (await closing).released : false }
          if (pending) return { state: "refused", released: false }
          const input = foregroundInput(action, frame)
          if (!input) return notStarted
          const id = ++nextId
          const reply = Promise.withResolvers<WindowsForegroundResult>()
          const interrupt = () => { void release() }
          active.addEventListener("abort", interrupt, { once: true })
          pending = { id, finish: result => { pending = undefined; reply.resolve(result) } }
          native.child.stdin.write(JSON.stringify({ id, ...input }) + "\n")
          try {
            const result = await Promise.race([reply.promise, delay(5_000, undefined, { ref: false })])
            if (!result || !result.released) {
              revoke("release_unverified")
              const stopped = await release()
              return { state: "unknown", released: stopped.released }
            }
            return result
          } finally { active.removeEventListener("abort", interrupt) }
        },
        release,
      }
    },
  }
}

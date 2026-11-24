import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { setTimeout as delay } from "node:timers/promises"
import sharp from "sharp"
import type { ComputerPointerGesture } from "@vykor/server/daemon-host"
import {
  ComputerForegroundStartError, frameContainsPoint, nativeRegion,
  type ComputerForeground, type ComputerForegroundCrop, type ComputerForegroundFrame,
  type ComputerForegroundRelease, type ComputerForegroundResult, type ComputerForegroundRevokeReason, type ComputerInputAction,
} from "./computer-platform"
import type { WindowsAppWindow } from "./windows-apps"
import { windowsForegroundQuery } from "./windows-foreground-query"

const virtualKeys: Record<string, number> = {
  backspace: 8, tab: 9, enter: 13, escape: 27, space: 32, pageup: 33, pagedown: 34,
  end: 35, home: 36, left: 37, up: 38, right: 39, down: 40, insert: 45, delete: 46,
  arrowleft: 37, arrowup: 38, arrowright: 39, arrowdown: 40,
}
const modifiers = { ctrl: 17, alt: 18, shift: 16 }
const pinnedDownKeys = new Set([16, 17, 18])

/** Convert model-visible pixels to physical coordinates in the original capture. */
export function foregroundInput(action: ComputerInputAction, frame?: ComputerForegroundFrame) {
  if ("x" in action) {
    if (
      !frame?.geometry.monitor ||
      !frame.signature ||
      !frameContainsPoint(frame, action.x, action.y)
    )
      return
    const { left, top } = frame.geometry
    const region = nativeRegion(frame)
    const screenX = (x: number) => left + region.x + Math.floor((x * region.width) / frame.width)
    const screenY = (y: number) => top + region.y + Math.floor((y * region.height) / frame.height)
    const point = {
      x: screenX(action.x),
      y: screenY(action.y),
      geometry: frame.geometry,
      signature: frame.signature,
      ...(frame.region ? { region: frame.region } : {}),
    }
    if (action.type === "drag") {
      if (
        !frameContainsPoint(frame, action.toX, action.toY) ||
        (action.x === action.toX && action.y === action.toY)
      )
        return
      return { type: action.type, ...point, toX: screenX(action.toX), toY: screenY(action.toY) }
    }
    if (action.type === "scroll_at") {
      const horizontal = action.direction === "left" || action.direction === "right"
      const delta =
        (action.amount ?? 1) *
        (action.direction === "down" || action.direction === "left" ? -120 : 120)
      return { type: action.type, ...point, horizontal, delta }
    }
    if (action.type === "hover") return { type: action.type, ...point }
    return {
      type: action.type,
      ...point,
      button: action.button ?? "left",
      ...(action.count ? { count: action.count } : {}),
      ...(action.modifiers ? { modifiers: action.modifiers.map((key) => modifiers[key]) } : {}),
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

/** Compare only the observed pixels around where input will land. */
async function pointerEvidence(action: ComputerPointerGesture, frame: ComputerForegroundFrame) {
  const image = sharp(Buffer.from(frame.data, "base64")).removeAlpha().toColourspace("srgb")
  const points =
    action.type === "drag"
      ? [
          { x: action.x, y: action.y },
          { x: action.toX, y: action.toY },
        ]
      : [action]
  return Promise.all(
    points.map(async ({ x, y }) => {
      const left = Math.max(0, x - 16),
        top = Math.max(0, y - 16)
      const width = Math.min(frame.width, x + 17) - left,
        height = Math.min(frame.height, y + 17) - top
      const pixels = await image.clone().extract({ left, top, width, height }).raw().toBuffer()
      return {
        left,
        top,
        width,
        height,
        digest: createHash("sha256").update(pixels).digest("base64"),
      }
    })
  )
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
Add-Type -ReferencedAssemblies $references -TypeDefinition ($env:VYKOR_FOREGROUND_SOURCE + $env:VYKOR_FOREGROUND_SOURCE_TAIL)
[VykorWindowsForeground]::Run($env:VYKOR_FOREGROUND_COMMAND, $env:VYKOR_FOREGROUND_WINDOW, $env:VYKOR_FOREGROUND_TEST_FAULT, $env:VYKOR_FOREGROUND_CROP)
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
  reason?: ComputerForegroundRevokeReason
  id?: number
  state?: ComputerForegroundResult["state"]
  released?: boolean
  frame?: ComputerForegroundFrame
}

type ForegroundFixtureGate = {
  fault: "lost-keyboard" | "hold-release" | "hold-activate"
  onHeld?: (upQueued: boolean) => void
  onPrepared?: () => void
}

function startNative(
  command: "capture" | "enter",
  window: WindowsAppWindow,
  onReply: (reply: NativeReply) => void,
  fault = "",
  crop?: ComputerForegroundCrop
) {
  const shell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
  const child = spawn(
    shell,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-Command", nativeScript],
    {
      windowsHide: true,
      stdio: ["pipe", "pipe", "ignore"],
      env: {
        ...process.env,
        VYKOR_FOREGROUND_COMMAND: command,
        VYKOR_FOREGROUND_WINDOW: windowIdentity(window),
        VYKOR_FOREGROUND_SOURCE: windowsForegroundQuery.slice(0, 20_000),
        VYKOR_FOREGROUND_SOURCE_TAIL: windowsForegroundQuery.slice(20_000),
        VYKOR_FOREGROUND_TEST_FAULT: fault,
        VYKOR_FOREGROUND_CROP: crop ? JSON.stringify(crop) : "",
      },
    }
  )
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

const notStarted: ComputerForegroundResult = { state: "refused", released: true }

export function createWindowsForeground(fixture?: ForegroundFixtureGate): ComputerForeground<WindowsAppWindow> {
  let occupied = false
  let releaseUnverified = false
  return {
    async capture(window, signal, crop) {
      signal.throwIfAborted()
      let result: ComputerForegroundFrame | undefined
      const native = startNative(
        "capture",
        window,
        (reply) => {
          if (reply.event === "frame") result = reply.frame
        },
        "",
        crop
      )
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
      let closing: Promise<ComputerForegroundRelease> | undefined
      let nextId = 0
      let pending: { id: number; finish: (result: ComputerForegroundResult) => void } | undefined
      const started = Promise.withResolvers<boolean>()
      function revoke(reason: ComputerForegroundRevokeReason) {
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
        if (!cleanup.released || !cleanup.exited) throw new ComputerForegroundStartError("无法确认前台助手已经退出。", cleanup)
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
          const evidence =
            "x" in action && frame
              ? {
                  patches: await pointerEvidence(action, frame),
                  imageWidth: frame.width,
                  imageHeight: frame.height,
                }
              : undefined
          active.throwIfAborted()
          if (revoked || pending)
            return { state: "refused", released: closing ? (await closing).released : !pending }
          const id = ++nextId
          const reply = Promise.withResolvers<ComputerForegroundResult>()
          const interrupt = () => { void release() }
          active.addEventListener("abort", interrupt, { once: true })
          pending = { id, finish: result => { pending = undefined; reply.resolve(result) } }
          native.child.stdin.write(JSON.stringify({ id, ...input, ...evidence }) + "\n")
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

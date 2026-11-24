import { randomUUID } from "node:crypto"
import { setTimeout as delay } from "node:timers/promises"
import type {
  ComputerAction,
  ComputerBridgeEvent,
  ComputerCaptureAction,
  ComputerForegroundAction,
  ComputerResult,
  ComputerRunIdentity,
  ComputerSemanticAction,
} from "@vykor/server/daemon-host"
import { computerActionNeedsApproval } from "@vykor/server/daemon-host"
import type { DesktopComputerActivity } from "../../../shared/computer-types"
import type { ComputerHostResponse, DesktopComputerApproval, DesktopComputerDispatch } from "./computer-bridge"
import {
  alreadySatisfied, approvalReason, findControl, sameActionState, observationDigest, projectObservation, selectionContext,
  supportsAction, verifiedEffect,
  type ComputerObservation,
} from "./computer-semantics"
import type { ComputerInteraction } from "./interaction"
import {
  ComputerAppUnavailableError, ComputerDriverError, ComputerDriverHandoffError, ComputerForegroundStartError,
  cropFromFrame, frameContainsPoint, sameCaptureEvidence,
  type ComputerApp, type ComputerDriver, type ComputerDriverObservation, type ComputerForegroundFrame,
  type ComputerForegroundLease, type ComputerInputAction, type ComputerPlatform, type ComputerWindow,
} from "./computer-platform"

const launchWaitMs = 15_000
const frameLifetimeMs = 30_000

type ExecuteEvent = Extract<ComputerBridgeEvent, { type: "execute" }>
type Target<Window extends ComputerWindow> = { app: ComputerApp; root: Window; window: Window; appRef: string; ref: string }
type ApproveAction = DesktopComputerApproval
type ApproveDispatch = DesktopComputerDispatch
type CurrentFrame<Window extends ComputerWindow> = { ref: string; target: Target<Window>; image: ComputerForegroundFrame; capturedAt: number }
type Occupation<Window extends ComputerWindow> = {
  grant: AbortController
  target: Target<Window>
  input?: { stop: AbortController; opening?: Promise<ComputerForegroundLease>; lease?: ComputerForegroundLease }
}
type Task<Window extends ComputerWindow> = {
  run: ComputerRunIdentity
  stop: AbortController
  work: AbortController
  capture: AbortController
  paused?: AbortController
  frame?: CurrentFrame<Window>
  imageRevocation?: Promise<boolean>
  captureRevocation?: DesktopComputerActivity["captureRevocation"]
  inputRelease?: DesktopComputerActivity["inputRelease"]
  occupation?: Occupation<Window>
  activity?: Pick<DesktopComputerActivity, "action" | "evidence" | "reason">
  allowed: Map<string, "task" | "remembered">
  apps: Map<string, ComputerApp>
  target?: Target<Window>
  launchToVerify?: { app: ComputerApp; windowHint?: string; previousWindows?: Window[] }
  observation?: ComputerObservation
}

class TargetError extends Error {}
class TargetPausedError extends TargetError {}

function sameRun(expected: ComputerRunIdentity, actual: ComputerRunIdentity): boolean {
  return expected.sessionId === actual.sessionId && expected.runId === actual.runId && expected.inputId === actual.inputId
}

function compareLabel(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase()
}

function matchDocuments<Window extends ComputerWindow>(windows: Window[], hint: string): Window[] {
  const needle = compareLabel(hint)
  const exact = windows.filter(window =>
    compareLabel(window.document ?? "") === needle ||
    compareLabel(window.title) === needle ||
    compareLabel(window.title.split(/\s[-–—]\s/u, 1)[0] ?? "") === needle)
  return exact.length ? exact : windows.filter(window => compareLabel(window.title).includes(needle))
}

function displayTitle(window: ComputerWindow): string {
  return window.title.replace(/\p{Cc}/gu, "").slice(0, 256)
}

const inputLabels: Record<ComputerForegroundAction["type"], string> = {
  click: "点击",
  drag: "拖拽",
  scroll_at: "滚轮",
  hover: "悬停",
  key: "按键",
  type_text: "输入文字",
}

function inputDescription(action: ComputerForegroundAction): string {
  switch (action.type) {
    case "click": {
      const gesture = action.count === 2 ? "双击" : action.button === "right" ? "右击" : "点击"
      const modifiers = action.modifiers?.length ? `${action.modifiers.join("+")}＋` : ""
      return `${modifiers}${gesture}画面中的 (${action.x}, ${action.y})`
    }
    case "drag":
      return `从 (${action.x}, ${action.y}) 拖拽到 (${action.toX}, ${action.toY})`
    case "scroll_at":
      return `在 (${action.x}, ${action.y}) 滚动滚轮`
    case "hover":
      return `将鼠标悬停在 (${action.x}, ${action.y})`
    case "key":
      return `按下 ${[...(action.modifiers ?? []), action.key].join("+")}`
    case "type_text":
      return "输入文字"
  }
}

function freshFrame(frame: CurrentFrame<ComputerWindow>, target: Target<ComputerWindow>): boolean {
  const age = Date.now() - frame.capturedAt
  return frame.target.ref === target.ref && age >= 0 && age <= frameLifetimeMs
}

function nativeInput(
  action: ComputerForegroundAction,
  focusIdentity: string | undefined
): ComputerInputAction {
  if ("frameRef" in action) {
    const { frameRef: _reference, ...gesture } = action
    return gesture
  }
  if (action.type === "type_text") return { type: "text", text: action.text, focusIdentity }
  return { ...action, focusIdentity }
}

async function requireDispatch(dispatch: ApproveDispatch | undefined, signal: AbortSignal): Promise<void> {
  if (!dispatch || !await dispatch(signal)) throw new TargetError("本次电脑操作的运行授权已失效。")
  signal.throwIfAborted()
}

/** The current Desktop connection owns one active run's application grants and window. */
export class ComputerHost<Window extends ComputerWindow> {
  private connection?: AbortSignal
  private task?: Task<Window>
  // An unresolved release blocks a new input lease even after a new run or connection.
  private inputCleanup: Promise<boolean>

  constructor(
    private readonly platform: ComputerPlatform<Window>,
    private readonly interaction: ComputerInteraction,
    previousInputCleanup = Promise.resolve(true),
  ) { this.inputCleanup = previousInputCleanup }

  waitForInputRelease(): Promise<boolean> {
    return this.inputCleanup
  }

  async yieldInputToBrowser(sessionId: string): Promise<boolean> {
    const task = this.findTask(sessionId)
    if (!task?.occupation) return task?.inputRelease === undefined ? true : this.inputCleanup
    task.observation = undefined
    task.frame = undefined
    const released = this.releaseInput(task)
    task.inputRelease = "pending"
    task.activity = { action: "退出电脑前台控制" }
    this.publish(task)
    const confirmed = await released
    if (this.task === task && !task.paused) {
      task.inputRelease = confirmed ? undefined : "failed"
      task.activity = { ...task.activity, evidence: confirmed ? "键鼠已释放。" : "无法确认键鼠已释放。" }
      this.publish(task)
    }
    return confirmed
  }

  runUsingRememberedApp(appId: string): ComputerRunIdentity | undefined {
    return this.task?.allowed.get(appId) === "remembered" ? this.task.run : undefined
  }

  revoke(sessionId: string, runId?: string): void {
    const task = this.findTask(sessionId, runId)
    if (task) this.stopTask(task)
  }

  pause(sessionId: string, runId?: string): boolean {
    const task = this.findTask(sessionId, runId)
    if (!task) return false
    this.pauseTask(task)
    return true
  }

  async resume(sessionId: string, runId?: string): Promise<boolean> {
    const task = this.findTask(sessionId, runId)
    const paused = task?.paused
    if (!task || !paused || !await this.inputCleanup || await task.imageRevocation === false || this.task !== task) return false
    if (task.target) {
      try {
        await this.liveTarget(task, task.target, task.stop.signal)
      } catch {
        // A different window must pass discovery and authorization again.
        task.target = undefined
      }
    }
    if (this.task !== task || task.paused !== paused || task.stop.signal.aborted) return false
    task.paused = undefined
    task.work = new AbortController()
    task.activity = { reason: task.target ? "已继续，请重新观察窗口。" : "目标已变化，请重新选择应用或窗口。" }
    paused.abort()
    this.publish(task)
    return true
  }

  setCaptureEnabled(sessionId: string, enabled: boolean, runId?: string): boolean {
    const task = this.findTask(sessionId, runId)
    if (!task) return false
    if (enabled) {
      if (task.captureRevocation) return false
      if (task.capture.signal.aborted) task.capture = new AbortController()
    } else {
      task.capture.abort()
      this.invalidateTaskImage(task)
    }
    this.publish(task)
    return true
  }

  async execute(
    event: ExecuteEvent, signal: AbortSignal, connection: AbortSignal, approve?: ApproveAction, authorizeDispatch?: ApproveDispatch,
  ): Promise<ComputerHostResponse> {
    let launchAttempted = false
    let task: Task<Window> | undefined
    let work: AbortSignal | undefined
    try {
      connection.throwIfAborted()
      signal.throwIfAborted()
      task = this.currentTask(event.run, connection)
      signal = AbortSignal.any([signal, connection, task.stop.signal])
      if (event.action.type === "handoff") {
        this.pauseTask(task, "请在目标应用中完成需要手动操作的步骤，然后回到聊天继续。")
        await this.waitUntilResumed(task, signal)
        return { text: JSON.stringify({ status: "resumed", next: "observe the current window again" }) }
      }
      await this.waitUntilResumed(task, signal)
      work = AbortSignal.any([signal, task.work.signal])
      return await this.perform(task, event.action, work, approve, authorizeDispatch, () => { launchAttempted = true }, event.fullAccess)
    } catch (error) {
      if (signal.aborted || connection.aborted) throw error
      if (task && error instanceof ComputerDriverHandoffError) {
        this.pauseTask(task, error.message)
        return { error: error.message, executionState: error.executionState }
      }
      if (work?.aborted) {
        const unknown = launchAttempted || error instanceof ComputerDriverError && error.executionState === "unknown"
        return { error: unknown ? "电脑操作已暂停，结果仍需核对。请在继续后重新观察窗口。"
          : "电脑操作已暂停。请在继续后重新观察窗口。", executionState: unknown ? "unknown" : "not_started" }
      }
      if (task && this.platform.foreground && (error instanceof TargetPausedError ||
        error instanceof ComputerAppUnavailableError && error.reason !== "app_changed")) {
        this.pauseTask(task, error.message)
        return { error: error.message, executionState: launchAttempted ? "unknown" : "not_started" }
      }
      if (task && error instanceof TargetError) {
        task.activity = { reason: error.message }
        this.publish(task)
      }
      if (error instanceof ComputerDriverError) return { error: error.message, executionState: error.executionState }
      const message = error instanceof TargetError || error instanceof ComputerAppUnavailableError ? error.message
        : launchAttempted ? "无法确认应用是否已启动。请查看桌面后再试。"
        : "无法核对目标应用或窗口。请重试。"
      return { error: message, executionState: launchAttempted ? "unknown" : "not_started" }
    }
  }

  private async perform(
    task: Task<Window>,
    action: Exclude<ComputerAction, { type: "handoff" }>,
    signal: AbortSignal,
    approve: ApproveAction | undefined,
    authorizeDispatch: ApproveDispatch | undefined,
    onLaunch: () => void,
    fullAccess?: true
  ): Promise<ComputerHostResponse> {
    let launchAttempted = false
    if (action.type === "capture") return this.captureWindow(task, signal, action)
    if (action.type === "foreground") return this.beginForeground(task, signal, fullAccess, approve, authorizeDispatch)
    if ("frameRef" in action || action.type === "key" || action.type === "type_text") {
      return this.foregroundAction(task, action, signal, approve, authorizeDispatch, fullAccess)
    }
    if (action.type === "observe") {
      const target = task.target
      const app = target?.app ?? task.launchToVerify?.app
      if (!app) throw new TargetError("请先找到并打开本次任务的目标应用。")
      try {
        this.assertPermission(task, app)
        const root = target?.root ?? await this.selectRoot(task,
          this.primaryWindows(await this.platform.apps.windows(app, signal), task.launchToVerify?.previousWindows),
          task.launchToVerify?.windowHint, true, signal, app.confirmExistingWindow)
        const bound = await this.bind(task, app, root, signal, target !== undefined)
        this.publish(task, "observing")
        if (!this.platform.openDriver) return this.ready(bound, "reused")
        return await this.useDriver(task, bound, signal, async driver => {
          const state = await driver.observe(signal)
          await this.liveTarget(task, bound, signal)
          task.launchToVerify = undefined
          return this.observed(task, bound, state, { status: "observed" })
        })
      } catch (error) {
        if (error instanceof ComputerDriverHandoffError) throw error
        task.target = target
        task.observation = undefined
        this.invalidateTaskImage(task)
        await this.releaseInput(task)
        throw error
      }
    }
    if (action.type !== "open_app") {
      task.frame = undefined
      // An action that may open a dialog or request human approval ends the current front input interval.
      await this.releaseInput(task)
      return await this.applySemanticAction(task, action, signal, fullAccess, approve, authorizeDispatch)
    }
    this.invalidateTaskImage(task)
    await this.releaseInput(task)
    if (await task.imageRevocation === false) throw new TargetError("无法确认上一次截图已撤回。")
    signal.throwIfAborted()
    this.publish(task)
    const { app: name, windowHint, newWindow } = action
    const known = task.apps.get(name)
    const apps = known ? [known] : /^app_[a-f\d-]{36}$/u.test(name) ? [] : await this.platform.apps.discover(name, signal)
    if (!apps.length) {
      const catalog = this.platform.apps.catalogName ?? "系统应用列表"
      throw new TargetError(`找不到已注册的应用。请确认应用已安装，并使用它在${catalog}中的名称。`)
    }
    const app = await this.choose(apps, (candidate, index) => ({
      label: candidate.name, detail: candidate.detail ?? `应用 ${index + 1}`,
    }), signal, task.run.sessionId)
    if (!this.hasPermission(task, app)) {
      const choice = await this.interaction.authorizeApp(app, signal, task.run.sessionId)
      if (!choice) throw new TargetError("用户没有授权本次任务使用这个应用。")
      signal.throwIfAborted()
      task.allowed.set(app.id, choice === "remembered" ? "remembered" : "task")
    }
    this.assertPermission(task, app)
    // Cross-application handoff invalidates the old observation before discovery or launch.
    if (task.target?.app.id !== app.id) task.target = undefined
    task.observation = undefined
    const current = task.target
    const windows = await this.platform.apps.windows(app, signal)
    signal.throwIfAborted()
    let roots = this.primaryWindows(windows)
    if (newWindow || !roots.length) {
      task.target = undefined
      if (!roots.length && windows.length)
        throw new TargetPausedError("应用的窗口目前无法安全接续。请先检查对话框，再继续。")
      this.assertPermission(task, app)
      await requireDispatch(authorizeDispatch, signal)
      launchAttempted = true
      onLaunch()
      const previousWindows = newWindow ? roots : undefined
      task.launchToVerify = { app, windowHint, previousWindows }
      await this.platform.apps.launch(app, signal)
      roots = await this.waitForWindow(app, signal, previousWindows)
    }
    const pinned = current && windowHint === undefined ? roots.find(window => this.sameWindow(current.root, window)) : undefined
    let root: Window
    try {
      root = await this.selectRoot(task, pinned ? [pinned] : roots, windowHint, launchAttempted, signal,
        pinned || launchAttempted ? undefined : app.confirmExistingWindow)
    } catch (error) {
      task.target = undefined
      throw error
    }
    const bound = await this.bind(task, app, root, signal)
    if (!launchAttempted) {
      try {
        await requireDispatch(authorizeDispatch, signal)
      } catch (error) {
        task.target = undefined
        throw error
      }
    }
    task.launchToVerify = undefined
    task.activity = { action: "打开应用", evidence: "已核对窗口" }
    this.publish(task)
    return this.ready(bound, launchAttempted ? "launched" : "reused")
  }

  private selectRoot(
    task: Task<Window>, roots: Window[], windowHint: string | undefined, launchAttempted: boolean,
    signal: AbortSignal, confirmWindow?: true,
  ) {
    const matches = windowHint ? matchDocuments(roots, windowHint) : roots
    if (!matches.length) throw new TargetError(launchAttempted
      ? "已请求启动应用，但尚未找到与任务匹配的窗口或文档。"
      : "应用正在运行，但没有与提示匹配的窗口或已打开文档。")
    const usable = matches.filter(window => !window.blocked)
    if (!usable.length)
      throw new TargetPausedError("目标窗口被对话框阻挡。请先处理该对话框，再继续。")
    return this.choose(
      usable, (candidate, index) => this.windowLabel(candidate, index), signal, task.run.sessionId,
      usable.length === 1 ? confirmWindow : undefined,
    )
  }

  private findTask(sessionId: string, runId?: string): Task<Window> | undefined {
    const task = this.task
    return task?.run.sessionId === sessionId && (runId === undefined || task.run.runId === runId) ? task : undefined
  }

  private publish(task: Task<Window>, phase?: DesktopComputerActivity["phase"]): void {
    if (phase !== "stopped" && this.task !== task) return
    const { frame, target, occupation, run, paused } = task
    this.interaction.publishActivity?.(run.sessionId, {
      runId: run.runId, phase: phase ?? (paused ? "paused" : occupation?.input?.lease ? "foreground" : "ready"),
      app: target?.app.name, title: target && displayTitle(target.window), ...task.activity,
      captureEnabled: !task.capture.signal.aborted,
      captureRevocation: task.captureRevocation, inputRelease: task.inputRelease,
      preview: frame && !paused && frame.target.ref === target?.ref ? {
        dataUrl: `data:${frame.image.mimeType};base64,${frame.image.data}`, width: frame.image.width, height: frame.image.height,
      } : undefined,
    })
  }

  private stopTask(task: Task<Window>): void {
    this.task = undefined
    task.stop.abort()
    task.observation = undefined
    this.invalidateTaskImage(task)
    task.activity = { reason: "控制已撤销。" }
    const waitingForInput = Boolean(task.occupation?.input) || task.inputRelease === "pending"
    const released = this.releaseInput(task)
    if (waitingForInput) task.inputRelease = "pending"
    this.publish(task, "stopped")
    void released.then(ok => {
      if (this.task) return
      task.inputRelease = ok ? undefined : "failed"
      task.activity = { ...task.activity, evidence: ok ? "输入已释放，前台控制已退出。" : "无法确认输入已释放。" }
      this.publish(task, "stopped")
    })
  }

  private pauseTask(task: Task<Window>, reason?: string): void {
    if (this.task !== task) return
    const previousPause = task.paused
    task.paused = new AbortController()
    previousPause?.abort()
    task.work.abort()
    this.invalidateTaskImage(task)
    task.observation = undefined
    task.activity = { reason }
    const paused = task.paused
    const released = this.releaseInput(task)
    task.inputRelease = "pending"
    this.publish(task)
    void released.then(ok => {
      if (this.task !== task || task.paused !== paused) return
      task.inputRelease = ok ? undefined : "failed"
      task.activity = { ...task.activity, evidence: ok ? "输入已释放。" : "无法确认输入已释放，继续前请重启 Desktop。" }
      this.publish(task)
    })
  }

  private invalidateTaskImage(task: Task<Window>): void {
    task.frame = undefined
    const confirmation = this.interaction.invalidateCapturedImage?.(task.run.sessionId, task.run.runId)
    if (!confirmation || task.imageRevocation === confirmation) return
    task.imageRevocation = confirmation
    task.captureRevocation = "pending"
    void confirmation.then(ok => {
      if (task.imageRevocation !== confirmation) return
      task.captureRevocation = ok ? undefined : "failed"
      if (this.task === task) this.publish(task)
      else if (!this.task && task.stop.signal.aborted) this.publish(task, "stopped")
    })
  }

  private async waitUntilResumed(task: Task<Window>, signal: AbortSignal): Promise<void> {
    while (task.paused) {
      const waiting = AbortSignal.any([signal, task.paused.signal])
      if (!waiting.aborted) await new Promise<void>(resolve => waiting.addEventListener("abort", () => resolve(), { once: true }))
      signal.throwIfAborted()
    }
    signal.throwIfAborted()
  }

  private releaseInput(task: Task<Window>, keepGrant = false): Promise<boolean> {
    const occupied = task.occupation
    const input = occupied?.input
    if (occupied) occupied.input = undefined
    if (!keepGrant) {
      task.occupation = undefined
      occupied?.grant.abort()
    }
    if (input) {
      const closing = input.lease?.release() ?? input.opening?.then(lease => lease.release(), (error: unknown) =>
        error instanceof ComputerForegroundStartError ? error.cleanup : undefined)
      input.stop.abort()
      const previous = this.inputCleanup
      this.inputCleanup = Promise.all([previous, closing]).then(([clean, result]) =>
        clean && (!result || result.released && result.exited), () => false)
    }
    return this.inputCleanup
  }

  private async enterInput(
    task: Task<Window>,
    occupied: Occupation<Window>,
    signal: AbortSignal
  ): Promise<ComputerForegroundLease> {
    if (!this.platform.foreground || !this.interaction.showForeground || !await this.inputCleanup || task.occupation !== occupied) {
      throw new TargetError("前台控制尚未就绪，或上次的输入释放未能确认。")
    }
    signal.throwIfAborted()
    const input: NonNullable<Occupation<Window>["input"]> = { stop: new AbortController() }
    occupied.input = input
    const lifetime = AbortSignal.any([task.stop.signal, occupied.grant.signal, input.stop.signal])
    const cancelStartup = () => input.stop.abort()
    signal.addEventListener("abort", cancelStartup, { once: true })
    try {
      input.opening = this.platform.foreground.enter(
        occupied.target.window,
        (reason) => {
          if (task.occupation !== occupied || occupied.input !== input) return
          if (reason === "emergency_stop") {
            this.stopTask(task)
            this.interaction.emergencyStop?.(task.run.sessionId, task.run.runId)
            return
          }
          if (reason === "physical_input") {
            this.pauseTask(task)
            return
          }
          this.pauseTask(task, reason === "focus_lost" ? "目标窗口已失焦。" : "前台控制已中断。")
        },
        lifetime
      )
      const lease = await input.opening
      try {
        await this.interaction.showForeground(task.run.sessionId, task.run.runId, lifetime)
      } catch {
        lifetime.throwIfAborted()
        throw new TargetError("无法显示前台控制提示，键鼠输入未派发。")
      }
      lifetime.throwIfAborted()
      signal.throwIfAborted()
      input.lease = lease
      this.publish(task)
      return lease
    } finally {
      signal.removeEventListener("abort", cancelStartup)
    }
  }

  private requireTarget(task: Task<Window>): Target<Window> {
    if (!task.target) throw new TargetError("请先找到并打开本次任务的目标应用。")
    return task.target
  }

  private async captureWindow(
    task: Task<Window>,
    signal: AbortSignal,
    action: ComputerCaptureAction
  ): Promise<ComputerResult> {
    if (!this.platform.foreground || task.capture.signal.aborted) throw new TargetError("本次任务的窗口画面未启用。")
    if (await task.imageRevocation === false) throw new TargetError("无法确认上一次截图已撤回。")
    const target = this.requireTarget(task)
    const previous = task.frame
    const crop =
      "region" in action && previous?.ref === action.frameRef && freshFrame(previous, target)
        ? cropFromFrame(previous.image, action.region)
        : undefined
    if ("region" in action && !crop)
      throw new TargetError("局部截图需要当前窗口最新画面内的有效范围。")
    const active = AbortSignal.any([signal, task.capture.signal])
    task.frame = undefined
    await this.liveTarget(task, target, active)
    this.publish(task, task.occupation?.input?.lease ? "foreground" : "observing")
    const image = await this.platform.foreground.capture(target.window, active, crop).catch(() => {
      active.throwIfAborted()
      if (crop) throw new TargetError("无法获取原尺寸局部截图。请重新截图或选择更小的范围。")
      throw new TargetPausedError("当前画面无法安全读取。请先检查目标窗口，再继续。")
    })
    await this.liveTarget(task, target, active)
    active.throwIfAborted()
    const { mimeType, data, width, height } = image
    if ("purpose" in action && action.purpose === "result") {
      return {
        text: JSON.stringify({ status: "captured", ...this.targetDetails(target) }),
        image: { mediaType: mimeType, data, width, height },
      }
    }
    const ref = `frame_${randomUUID()}`
    task.frame = { ref, target, image, capturedAt: Date.now() }
    task.activity = { action: "观察窗口画面", evidence: "已核对目标窗口" }
    this.publish(task)
    return {
      text: JSON.stringify({ status: "captured", ...this.targetDetails(target), frame: { ref, width, height } }),
      image: { mediaType: mimeType, data, width, height },
    }
  }

  private async beginForeground(task: Task<Window>, signal: AbortSignal, fullAccess?: true, approve?: ApproveAction, dispatch?: ApproveDispatch): Promise<ComputerResult> {
    if (!this.platform.foreground || !this.interaction.emergencyStop || !this.interaction.showForeground)
      throw new TargetError("当前 Desktop 未提供可用的前台提示和本机急停。")
    if (task.occupation) throw new TargetError("目标窗口的前台控制已获准。请先观察当前界面。")
    const target = this.requireTarget(task)
    await this.liveTarget(task, target, signal)
    if (!await this.inputCleanup) throw new TargetError("无法确认上次输入已释放，继续前请重启 Desktop。")
    task.frame = undefined
    task.observation = undefined
    const occupied: Occupation<Window> = { grant: new AbortController(), target }
    task.occupation = occupied
    const requestSignal = AbortSignal.any([signal, occupied.grant.signal])
    try {
      if (!fullAccess) {
        task.activity = { action: "等待前台控制授权" }
        this.publish(task)
        if (!approve || !await approve({ proposalId: randomUUID(), reason:
          `允许 Vykor 暂时使用键鼠操作「${displayTitle(target.window).slice(0, 150)}」吗？按 Esc 可停止。`,
        }, requestSignal)) throw new TargetError("本次前台控制没有获准。")
      }
      await this.liveTarget(task, target, requestSignal)
      await requireDispatch(dispatch, requestSignal)
      await this.enterInput(task, occupied, requestSignal)
      task.activity = { action: "占用前台", evidence: "已确认目标窗口获得焦点" }
      this.publish(task)
      return { text: JSON.stringify({ status: "foreground", ...this.targetDetails(target), next: "observe or capture the current window" }) }
    } catch (error) {
      if (task.occupation === occupied) await this.releaseInput(task)
      if (error instanceof TargetError) throw error
      throw new TargetError("无法安全取得目标窗口的前台控制。")
    }
  }

  private async foregroundAction(
    task: Task<Window>,
    action: ComputerForegroundAction,
    signal: AbortSignal,
    approve?: ApproveAction,
    dispatch?: ApproveDispatch,
    fullAccess?: true
  ): Promise<ComputerHostResponse> {
    const occupied = task.occupation
    const target = task.target
    let lease = occupied?.input?.lease
    const pointer = "frameRef" in action
    const frame = pointer || !task.frame?.image.region ? task.frame : undefined
    const observation = task.observation
    if (!this.platform.foreground || !occupied || !target || !lease || target.ref !== occupied.target.ref) {
      throw new TargetError("请先为当前窗口取得前台控制许可，再重新观察。")
    }
    if (!frame && observation?.windowRef !== target.ref) throw new TargetError("请先重新观察前台窗口。")
    const isFresh = () => !frame || (task.frame === frame && freshFrame(frame, target))
    if (!isFresh()) throw new TargetError("目标画面已变化，请重新截图后再操作。")
    if (
      pointer &&
      (!frame ||
        frame.ref !== action.frameRef ||
        !frameContainsPoint(frame.image, action.x, action.y) ||
        (action.type === "drag" && !frameContainsPoint(frame.image, action.toX, action.toY)))
    ) {
      throw new TargetError("鼠标操作需要当前窗口最新画面中的有效坐标。")
    }
    const focusIdentity = frame ? frame.image.focusIdentity : observation?.focusIdentity
    if (!pointer && !focusIdentity)
      throw new TargetError("无法核实观察时的键盘焦点。请重新观察后再操作。")
    const operationSignal = AbortSignal.any([signal, occupied.grant.signal, ...(frame ? [task.capture.signal] : [])])
    task.observation = undefined
    let attempted = false
    try {
      if (!fullAccess && computerActionNeedsApproval(action)) {
        if (!(await this.releaseInput(task, true))) throw new TargetError("无法确认输入已释放。")
        task.activity = { action: "等待操作确认" }
        this.publish(task)
        if (
          !approve ||
          !(await approve(
            {
              proposalId: randomUUID(),
              reason: `允许在「${displayTitle(target.window).slice(0, 150)}」窗口${inputDescription(action)}吗？该操作可能改变应用状态。`,
            },
            operationSignal
          ))
        )
          throw new TargetError("该操作没有获得本次批准。")
        if (!isFresh()) throw new TargetError("目标画面已变化，请重新截图后再操作。")
        await this.liveTarget(task, target, operationSignal)
        lease = await this.enterInput(task, occupied, operationSignal)
        if (frame && !pointer) {
          const latest = await this.platform.foreground.capture(target.window, operationSignal)
          if (!sameCaptureEvidence(frame.image, latest))
            throw new TargetError("窗口内容在确认期间已变化，请重新观察。")
        }
        if (!frame && observation)
          await this.useDriver(task, target, operationSignal, async (driver) => {
            const current = await driver.observe(operationSignal)
            if (
              current.focusIdentity !== focusIdentity ||
              observationDigest(current) !== observation.digest
            ) {
              throw new TargetError("控件状态已变化，请重新观察后再操作。")
            }
          })
      }
      if (!isFresh()) throw new TargetError("目标画面已变化，请重新截图后再操作。")
      task.frame = undefined
      await this.liveTarget(task, target, operationSignal)
      await requireDispatch(dispatch, operationSignal)
      attempted = true
      const result = await lease.perform(
        nativeInput(action, focusIdentity),
        pointer ? frame?.image : undefined,
        operationSignal
      )
      if (!result.released || result.state !== "sent") {
        this.pauseTask(task, result.released ? "目标已变化或无法核实按键鼠标输入。" : "未能核实键鼠已释放。")
        return { error: "前台输入未通过核验，请检查目标窗口。", executionState: result.state === "refused" ? "not_started" : "unknown" }
      }
      if (operationSignal.aborted) return { error: "已停止前台操作，应用结果仍需核对。", executionState: "unknown" }
      task.activity = {
        action: inputLabels[action.type],
        evidence: "已派发输入，请重新观察应用结果",
      }
      this.publish(task)
      return { status: "sent", text: JSON.stringify({ status: "sent", inputReleased: true, ...this.targetDetails(target), next: "inspect the application result" }) }
    } catch (error) {
      if (this.task === task && task.occupation === occupied) {
        task.frame = undefined
        await this.releaseInput(task)
      }
      if (attempted) return { error: "前台输入可能已经派发，应用结果仍需核对。", executionState: "unknown" }
      if (error instanceof TargetError || error instanceof ComputerDriverHandoffError) throw error
      throw new TargetError("前台窗口或输入状态已变化，请重新观察。")
    }
  }

  private currentTask(run: ComputerRunIdentity, connection: AbortSignal): Task<Window> {
    if (this.connection !== connection) {
      if (this.task) this.stopTask(this.task)
      this.connection = connection
      this.task = undefined
      connection.addEventListener("abort", () => {
        if (this.connection === connection) {
          this.connection = undefined
          if (this.task) this.stopTask(this.task)
        }
      }, { once: true })
    }
    if (this.task && !sameRun(this.task.run, run)) throw new TargetError("另一个运行仍拥有电脑操作许可。")
    if (!this.task) {
      this.task = { run, stop: new AbortController(), work: new AbortController(), capture: new AbortController(), allowed: new Map(), apps: new Map() }
    }
    return this.task
  }

  private hasPermission(task: Task<Window>, app: ComputerApp): boolean {
    const grant = task.allowed.get(app.id)
    return grant === "task" || (grant === "remembered" && this.interaction.isRememberedApp?.(app.id) === true)
  }

  private assertPermission(task: Task<Window>, app: ComputerApp): void {
    if (!this.hasPermission(task, app)) throw new TargetError("此应用的许可已撤销。请重新授权后继续。")
  }

  private sameWindow(expected: Window, actual: Window): boolean {
    return this.platform.sameWindowInstance(expected, actual) && expected.title === actual.title && expected.document === actual.document
  }

  private sameKnownDocument(expected: Window, actual: Window): boolean {
    return Boolean(expected.document) && expected.document === actual.document && this.platform.sameWindowInstance(expected, actual)
  }

  private primaryWindows(windows: Window[], previousWindows?: Window[]): Window[] {
    return windows.filter(window => window.ownerWindowId === undefined &&
      !previousWindows?.some(previous => this.platform.sameWindowInstance(previous, window)))
  }

  private async waitForWindow(app: ComputerApp, signal: AbortSignal, previousWindows?: Window[]): Promise<Window[]> {
    const deadline = AbortSignal.timeout(launchWaitMs)
    const waiting = AbortSignal.any([deadline, signal])
    try {
      for (;;) {
        waiting.throwIfAborted()
        const windows = this.primaryWindows(await this.platform.apps.windows(app, waiting), previousWindows)
        if (windows.length) return windows
        await delay(250, undefined, { signal: waiting })
      }
    } catch (error) {
      if (deadline.aborted && !signal.aborted) {
        throw new TargetError(previousWindows
          ? "已请求打开新窗口，但尚未找到独立的新窗口。应用可能复用了现有窗口或打开了标签页。"
          : "已请求启动应用，但在等待时间内没有找到可用窗口。请检查任务栏或系统提示。")
      }
      throw error
    }
  }

  private async bind(
    task: Task<Window>, app: ComputerApp, root: Window, signal: AbortSignal,
    allowRetitle = false,
  ): Promise<Target<Window>> {
    const previous = task.target
    task.target = undefined
    task.observation = undefined
    this.assertPermission(task, app)
    let fresh = await this.platform.apps.windows(app, signal)
    signal.throwIfAborted()
    let refreshedRoot = fresh.find(window => this.sameWindow(root, window))
    if (!refreshedRoot && allowRetitle) {
      const renamed = fresh.find(window => this.sameKnownDocument(root, window) ||
        (!root.document && !window.document && this.platform.sameWindowInstance(root, window)))
      if (renamed && !renamed.blocked && !this.sameKnownDocument(root, renamed)) {
        await this.choose([renamed], (candidate, index) => this.windowLabel(candidate, index), signal, task.run.sessionId, true)
        fresh = await this.platform.apps.windows(app, signal)
        signal.throwIfAborted()
        refreshedRoot = fresh.find(window => this.sameWindow(renamed, window))
      } else {
        refreshedRoot = renamed
      }
    }
    if (!refreshedRoot) {
      throw new TargetError("目标窗口或文档已变化。请重新查找目标。")
    }
    if (refreshedRoot.blocked) throw new TargetPausedError("目标窗口被对话框阻挡。请先处理，再继续。")
    const owned = fresh.filter(window => window.ownerWindowId === root.windowId)
    const usable = owned.filter(window => !window.blocked)
    if (owned.length && !usable.length) throw new TargetPausedError("目标对话框需要你接管。处理后请在聊天中继续。")
    const pinned = previous && this.sameWindow(previous.root, root)
      ? usable.find(window => this.sameWindow(previous.window, window)) : undefined
    const selected = pinned ?? (usable.length
      ? await this.choose(usable, (window, index) => this.windowLabel(window, index), signal, task.run.sessionId)
      : refreshedRoot)
    if (!pinned && usable.length > 1) {
      const confirmed = await this.platform.apps.windows(app, signal)
      signal.throwIfAborted()
      if (!confirmed.some(window => !window.blocked && this.sameWindow(refreshedRoot, window)) ||
          !confirmed.some(window => !window.blocked && this.sameWindow(selected, window))) {
        throw new TargetError("所选对话框已变化。请重新查找目标。")
      }
    }
    this.assertPermission(task, app)
    let appRef = [...task.apps].find(([, candidate]) => candidate.id === app.id)?.[0]
    if (!appRef) {
      appRef = `app_${randomUUID()}`
      task.apps.set(appRef, app)
    }
    const ref = previous && this.sameWindow(previous.window, selected) ? previous.ref : `window_${randomUUID()}`
    if (previous && previous.ref !== ref) {
      this.invalidateTaskImage(task)
      if (await task.imageRevocation === false) throw new TargetError("无法确认上一次截图已撤回。")
      signal.throwIfAborted()
    }
    if (task.occupation && task.occupation.target.ref !== ref) {
      await this.releaseInput(task)
      signal.throwIfAborted()
    }
    const target = { app, root: refreshedRoot, window: selected, appRef, ref }
    task.target = target
    return target
  }

  private ready(target: Target<Window>, source: "reused" | "launched"): ComputerResult {
    return { text: JSON.stringify({ status: "ready", ...this.targetDetails(target), source, next: { action: "observe" } }) }
  }

  private targetDetails(target: Target<Window>) {
    return {
      app: { name: target.app.name, ref: target.appRef },
      window: { title: displayTitle(target.window), ref: target.ref, kind: target.window.ownerWindowId === undefined ? "window" : "dialog" },
    }
  }

  private observed(
    task: Task<Window>, target: Target<Window>, state: ComputerDriverObservation, details: { status: string; evidence?: string },
  ): ComputerResult {
    const snapshot = projectObservation(target.ref, state)
    task.observation = snapshot
    task.activity = details.status === "observed"
      ? { action: "观察控件", evidence: "已核对目标窗口" }
      : { action: "控件操作", evidence: details.status === "observed_change" ? "观察到界面变化" : "已读回控件结果" }
    this.publish(task)
    const status = details.status === "observed" ? "observed" : details.status === "already_satisfied" ? "unchanged" : undefined
    return { ...(status ? { status } : {}), text: JSON.stringify({
      ...details, ...this.targetDetails(target), observation: snapshot.display,
    }) }
  }

  private async liveTarget(task: Task<Window>, target: Target<Window>, signal: AbortSignal, allowRetitle = false): Promise<Target<Window>> {
    signal.throwIfAborted()
    if (this.task !== task || task.target !== target) throw new TargetError("窗口许可已变化。请重新观察。")
    this.assertPermission(task, target.app)
    const windows = await this.platform.apps.windows(target.app, signal)
    signal.throwIfAborted()
    this.assertPermission(task, target.app)
    const match = (expected: Window, actual: Window) =>
      this.sameWindow(expected, actual) || (allowRetitle && this.sameKnownDocument(expected, actual))
    const root = windows.find(current => !current.blocked && match(target.root, current))
    const window = windows.find(current => !current.blocked && match(target.window, current))
    if (!root || !window || (window.ownerWindowId === undefined &&
        windows.some(current => current.ownerWindowId === root.windowId))) {
      throw new TargetError("目标窗口、文档或对话框已改变。请重新观察后再操作。")
    }
    return { ...target, root, window }
  }

  private async useDriver<T>(
    task: Task<Window>, target: Target<Window>, signal: AbortSignal, work: (driver: ComputerDriver) => Promise<T>,
  ): Promise<T> {
    if (!this.platform.openDriver) throw new TargetError("控件驱动不可用。")
    await this.liveTarget(task, target, signal)
    const driver = await this.platform.openDriver(target.window, signal)
    try {
      signal.throwIfAborted()
      await this.liveTarget(task, target, signal)
      return await work(driver)
    } finally {
      await driver.close()
    }
  }

  private async applySemanticAction(
    task: Task<Window>, action: ComputerSemanticAction, signal: AbortSignal, fullAccess?: true, approve?: ApproveAction, authorizeDispatch?: ApproveDispatch,
  ): Promise<ComputerHostResponse> {
    const { target, observation } = task
    const expected = observation?.elements.get(action.elementRef)
    if (!target || !observation || observation.windowRef !== target.ref || !expected || !supportsAction(expected, action)) {
      throw new TargetError("控件引用已过期或不支持该操作。请重新观察窗口。")
    }
    task.observation = undefined
    const prepare = async (driver: ComputerDriver) => {
      const state = await driver.observe(signal)
      const control = findControl(expected, state)
      // Buttons may act on other controls, and the same editor can serve different selected records.
      const contextChanged = action.type === "invoke" ? observationDigest(state) !== observation.digest
        : action.type !== "scroll" && selectionContext(state) !== observation.selection
      if (!control || !supportsAction(control, action) || !sameActionState(action, expected, control) || contextChanged) {
        throw new TargetError("控件或窗口状态已变化。请重新观察后再操作。")
      }
      return { state, control }
    }
    const requiresApproval = !fullAccess && computerActionNeedsApproval(action)
    if (requiresApproval) {
      const prior = await this.useDriver(task, target, signal, prepare)
      if (alreadySatisfied(action, prior.control)) {
        return this.observed(task, target, prior.state, { status: "already_satisfied" })
      }
      if (!approve || !await approve({
        proposalId: randomUUID(), reason: approvalReason(target.app.name, target.window.title, action, expected),
      }, signal)) throw new TargetError("该操作没有获得本次批准。")
      signal.throwIfAborted()
    }

    let dispatched = false
    let accepted = false
    try {
      return await this.useDriver(task, target, signal, async driver => {
        const { state, control } = await prepare(driver)
        await this.liveTarget(task, target, signal)
        if (alreadySatisfied(action, control)) return this.observed(task, target, state, { status: "already_satisfied" })
        await requireDispatch(authorizeDispatch, signal)
        const { elementRef: _ref, ...operation } = action
        dispatched = true
        await driver.act({ ...operation, token: control.token }, signal)
        accepted = true
        const live = await this.liveTarget(task, target, signal, action.type === "set_text")
        const result = await driver.observe(signal, { title: live.window.title })
        const verified = await this.liveTarget(task, target, signal, action.type === "set_text")
        if (!this.sameWindow(live.window, verified.window) ||
          (action.type === "set_text" && selectionContext(result) !== observation.selection)) {
          throw new TargetError("读回期间目标窗口或选中记录已变化。")
        }
        const evidence = verifiedEffect(action, control, state, result)
        if (!evidence) throw new TargetError("已派发操作，但读回未能核实它的效果。请重新观察后再决定是否重试。")
        task.target = verified
        return this.observed(task, verified, result, { status: evidence === "controls_changed" ? "observed_change" : "verified", evidence })
      })
    } catch (error) {
      if (error instanceof ComputerDriverHandoffError && accepted) {
        this.pauseTask(task, error.message)
        return { error: error.message + " 已派发的动作仍需核对结果。", executionState: "unknown" }
      }
      if (!dispatched || (error instanceof ComputerDriverError && !accepted)) throw error
      return {
        error: error instanceof TargetError ? error.message : "已派发操作，但无法核实结果。请重新观察窗口。",
        executionState: "unknown",
      }
    }
  }

  private windowLabel(window: Window, index: number) {
    const position = window.position && `屏幕位置 ${window.position.left}, ${window.position.top}`
    return {
      label: displayTitle(window),
      detail: [`窗口 ${index + 1}`, window.document, position].filter(Boolean).join(" · "),
    }
  }

  private async choose<T>(
    candidates: readonly T[], describe: (candidate: T, index: number) => { label: string; detail?: string },
    signal: AbortSignal, sessionId: string, confirmChange?: true,
  ): Promise<T> {
    signal.throwIfAborted()
    if (candidates.length === 1 && !confirmChange) return candidates[0]!
    const choices = candidates.map((candidate, index) => ({ id: randomUUID(), ...describe(candidate, index) }))
    const selection = await this.interaction.chooseTarget(choices, signal, sessionId, confirmChange)
    signal.throwIfAborted()
    const index = choices.findIndex(candidate => candidate.id === selection)
    if (index < 0) throw new TargetError("用户没有选择目标。")
    return candidates[index]!
  }
}

import { randomUUID } from "node:crypto"
import { setTimeout as delay } from "node:timers/promises"
import type {
  ComputerAction, ComputerBridgeEvent, ComputerResult, ComputerRunIdentity, ComputerSemanticAction,
} from "@vykor/server/daemon-host"
import { COMPUTER_STOP_SHORTCUT, type DesktopComputerActivity } from "../../../shared/computer-types"
import type { ComputerHostResponse, DesktopComputerApproval, DesktopComputerDispatch } from "./computer-bridge"
import {
  alreadySatisfied, approvalReason, findControl, needsApproval, observationDigest, projectObservation, supportsAction, verifiedEffect,
  type ComputerObservation,
} from "./computer-semantics"
import type { ComputerInteraction } from "./interaction"
import { WindowsAppUnavailableError, type WindowsApp, type WindowsApps, type WindowsAppWindow } from "./windows-apps"
import { WindowsDriverError, WindowsDriverHandoffError, type WindowsDriver, type WindowsDriverObservation } from "./windows-driver"
import { WindowsForegroundStartError, type WindowsForeground, type WindowsForegroundFrame, type WindowsForegroundLease } from "./windows-foreground"

const launchWaitMs = 15_000
const frameLifetimeMs = 30_000

type ExecuteEvent = Extract<ComputerBridgeEvent, { type: "execute" }>
type Target = { app: WindowsApp; root: WindowsAppWindow; window: WindowsAppWindow; appRef: string; ref: string }
type ApproveAction = DesktopComputerApproval
type ApproveDispatch = DesktopComputerDispatch
type InputAction = Extract<ComputerAction, { type: "click" | "key" | "type_text" }>
type CurrentFrame = { ref: string; target: Target; image: WindowsForegroundFrame; capturedAt: number }
type Occupation = {
  grant: AbortController
  target: Target
  input?: { stop: AbortController; opening?: Promise<WindowsForegroundLease>; lease?: WindowsForegroundLease }
}
type Task = {
  automatic?: true
  run: ComputerRunIdentity
  stop: AbortController
  work: AbortController
  capture: AbortController
  paused?: AbortController
  frame?: CurrentFrame
  imageRevocation?: Promise<boolean>
  captureRevocation?: DesktopComputerActivity["captureRevocation"]
  inputRelease?: DesktopComputerActivity["inputRelease"]
  occupation?: Occupation
  activity?: Pick<DesktopComputerActivity, "action" | "evidence" | "reason">
  allowed: Map<string, "task" | "remembered">
  apps: Map<string, WindowsApp>
  target?: Target
  launchToVerify?: { app: WindowsApp; windowHint?: string }
  observation?: ComputerObservation
}

class TargetError extends Error {}
class TargetPausedError extends TargetError {}

function sameWindowInstance(expected: WindowsAppWindow, actual: WindowsAppWindow): boolean {
  return expected.windowId === actual.windowId && expected.ownerWindowId === actual.ownerWindowId &&
    expected.pid === actual.pid && expected.threadId === actual.threadId && expected.sessionId === actual.sessionId &&
    expected.processStartedAt === actual.processStartedAt && expected.processStartKey === actual.processStartKey &&
    expected.applicationPid === actual.applicationPid && expected.applicationStartKey === actual.applicationStartKey
}

function sameWindow(expected: WindowsAppWindow, actual: WindowsAppWindow): boolean {
  return sameWindowInstance(expected, actual) && expected.title === actual.title && expected.document === actual.document
}

function sameRun(expected: ComputerRunIdentity, actual: ComputerRunIdentity): boolean {
  return expected.sessionId === actual.sessionId && expected.runId === actual.runId && expected.inputId === actual.inputId
}

function compareLabel(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase()
}

function matchDocuments(windows: WindowsAppWindow[], hint: string): WindowsAppWindow[] {
  const needle = compareLabel(hint)
  const exact = windows.filter(window =>
    compareLabel(window.document ?? "") === needle ||
    compareLabel(window.title) === needle ||
    compareLabel(window.title.split(/\s[-–—]\s/u, 1)[0] ?? "") === needle)
  return exact.length ? exact : windows.filter(window => compareLabel(window.title).includes(needle))
}

function primaryWindows(windows: WindowsAppWindow[]): WindowsAppWindow[] {
  return windows.filter(window => window.ownerWindowId === undefined)
}

function displayTitle(window: WindowsAppWindow): string {
  return window.title.replace(/\p{Cc}/gu, "").slice(0, 256)
}

function foregroundNeedsApproval(action: InputAction, app: WindowsApp): boolean {
  if (action.type === "type_text") return app.builtIn !== "notepad"
  return action.type === "click" || !!action.modifiers?.length || !/^(?:Tab|Arrow(?:Up|Down|Left|Right)|Home|End|PageUp|PageDown)$/iu.test(action.key)
}

function sameCaptureEvidence(saved: WindowsForegroundFrame, latest: WindowsForegroundFrame): boolean {
  const before = saved.geometry
  const after = latest.geometry
  return saved.focusIdentity === latest.focusIdentity && saved.data === latest.data && saved.width === latest.width && saved.height === latest.height &&
    before.left === after.left && before.top === after.top && before.width === after.width && before.height === after.height &&
    before.monitor === after.monitor && before.dpi === after.dpi
}

async function requireDispatch(dispatch: ApproveDispatch | undefined, signal: AbortSignal): Promise<void> {
  if (!dispatch || !await dispatch(signal)) throw new TargetError("本次电脑操作的运行授权已失效。")
  signal.throwIfAborted()
}

/** The current Desktop connection owns one active run's application grants and window. */
export class ComputerHost {
  private connection?: AbortSignal
  private task?: Task
  // An unresolved release blocks a new input lease even after a new run or connection.
  private inputCleanup: Promise<boolean>

  constructor(
    private readonly apps: Pick<WindowsApps, "discover" | "windows" | "launch">,
    private readonly interaction: ComputerInteraction,
    private readonly openDriver?: (target: WindowsAppWindow, signal: AbortSignal) => Promise<WindowsDriver>,
    private readonly foreground?: WindowsForeground,
    previousInputCleanup = Promise.resolve(true),
  ) { this.inputCleanup = previousInputCleanup }

  waitForInputRelease(): Promise<boolean> {
    return this.inputCleanup
  }

  async yieldInputToBrowser(sessionId: string): Promise<boolean> {
    const task = this.findTask(sessionId)
    if (!task) return this.inputCleanup
    const leavingForeground = task.occupation !== undefined
    task.observation = undefined
    this.invalidateTaskImage(task)
    const released = this.releaseInput(task)
    if (leavingForeground) {
      task.inputRelease = "pending"
      task.activity = { action: "退出电脑前台控制" }
    }
    this.publish(task)
    const confirmed = await released
    if (leavingForeground && this.task === task && !task.paused) {
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
    this.pauseTask(task, "电脑操作已暂停。")
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
    automatic?: true,
  ): Promise<ComputerHostResponse> {
    let launchAttempted = false
    let task: Task | undefined
    let work: AbortSignal | undefined
    try {
      connection.throwIfAborted()
      signal.throwIfAborted()
      task = this.currentTask(event.run, connection, automatic)
      signal = AbortSignal.any([signal, connection, task.stop.signal])
      if (event.action.type === "handoff") {
        this.pauseTask(task, "请在目标应用中完成需要手动操作的步骤，然后回到聊天继续。")
        await this.waitUntilResumed(task, signal)
        return { text: JSON.stringify({ status: "resumed", next: "observe the current window again" }) }
      }
      await this.waitUntilResumed(task, signal)
      work = AbortSignal.any([signal, task.work.signal])
      return await this.perform(task, event.action, work, approve, authorizeDispatch, () => { launchAttempted = true })
    } catch (error) {
      if (signal.aborted || connection.aborted) throw error
      if (task && error instanceof WindowsDriverHandoffError) {
        this.pauseTask(task, error.message)
        return { error: error.message, executionState: error.executionState }
      }
      if (work?.aborted) {
        const unknown = launchAttempted || error instanceof WindowsDriverError && error.executionState === "unknown"
        return { error: unknown ? "电脑操作已暂停，结果仍需核对。请在继续后重新观察窗口。"
          : "电脑操作已暂停。请在继续后重新观察窗口。", executionState: unknown ? "unknown" : "not_started" }
      }
      if (task && this.foreground && (error instanceof TargetPausedError ||
        error instanceof WindowsAppUnavailableError && error.reason !== "app_changed")) {
        const reason = error instanceof TargetPausedError ? error.message : this.unavailableMessage(error)
        this.pauseTask(task, reason)
        return { error: reason, executionState: launchAttempted ? "unknown" : "not_started" }
      }
      if (task && error instanceof TargetError) {
        task.activity = { reason: error.message }
        this.publish(task)
      }
      if (error instanceof WindowsDriverError) return { error: error.message, executionState: error.executionState }
      const message = error instanceof TargetError ? error.message
        : error instanceof WindowsAppUnavailableError ? this.unavailableMessage(error)
        : launchAttempted ? "无法确认应用是否已启动。请查看桌面后再试。"
        : "无法核对 Windows 应用或窗口。请重试。"
      return { error: message, executionState: launchAttempted ? "unknown" : "not_started" }
    }
  }

  private async perform(
    task: Task, action: Exclude<ComputerAction, { type: "handoff" }>, signal: AbortSignal,
    approve: ApproveAction | undefined, authorizeDispatch: ApproveDispatch | undefined, onLaunch: () => void,
  ): Promise<ComputerHostResponse> {
    let launchAttempted = false
    if (action.type === "capture") return this.captureWindow(task, signal)
    if (action.type === "foreground") return this.beginForeground(task, signal, approve, authorizeDispatch)
    if (action.type === "click" || action.type === "key" || action.type === "type_text") {
      return this.foregroundAction(task, action, signal, approve, authorizeDispatch)
    }
    if (action.type === "observe") {
      const target = task.target
      const app = target?.app ?? task.launchToVerify?.app
      if (!app) throw new TargetError("请先找到并打开本次任务的目标应用。")
      try {
        this.assertPermission(task, app)
        const root = target?.root ?? await this.selectRoot(task,
          primaryWindows(await this.apps.windows(app, signal)), task.launchToVerify?.windowHint, true, signal)
        const bound = await this.bind(task, app, root, signal, target !== undefined)
        this.publish(task, "observing")
        if (!this.openDriver) return this.ready(bound, "reused")
        return await this.useDriver(task, bound, signal, async driver => {
          const state = await driver.observe(signal)
          await this.liveTarget(task, bound, signal)
          task.launchToVerify = undefined
          return this.observed(task, bound, state, { status: "observed" })
        })
      } catch (error) {
        if (error instanceof WindowsDriverHandoffError) throw error
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
      return await this.applySemanticAction(task, action, signal, approve, authorizeDispatch)
    }
    this.invalidateTaskImage(task)
    await this.releaseInput(task)
    if (await task.imageRevocation === false) throw new TargetError("无法确认上一次截图已撤回。")
    signal.throwIfAborted()
    this.publish(task)
    const { app: name, windowHint } = action
    const known = task.apps.get(name)
    const apps = known ? [known] : /^app_[a-f\d-]{36}$/u.test(name) ? [] : await this.apps.discover(name, signal)
    if (!apps.length) throw new TargetError("找不到已注册的 Windows 应用。请确认应用已安装，并使用它在开始菜单中的名称。")
    const app = await this.choose(apps, (candidate, index) => ({
      label: candidate.name, detail: candidate.detail ?? `Windows 应用 ${index + 1}`,
    }), signal, task.run.sessionId)
    if (!this.hasPermission(task, app)) {
      const choice = await this.interaction.authorizeApp(app, signal, task.run.sessionId, task.automatic)
      if (!choice) throw new TargetError("用户没有授权本次任务使用这个应用。")
      signal.throwIfAborted()
      task.allowed.set(app.id, choice === "remembered" ? "remembered" : "task")
    }
    this.assertPermission(task, app)
    // Cross-application handoff invalidates the old observation before discovery or launch.
    if (task.target?.app.id !== app.id) task.target = undefined
    task.observation = undefined
    const current = task.target
    const windows = await this.apps.windows(app, signal)
    signal.throwIfAborted()
    let roots = primaryWindows(windows)
    if (!roots.length) {
      task.target = undefined
      if (windows.length) throw new TargetPausedError("应用的窗口目前无法安全接续。请先检查对话框，再继续。")
      this.assertPermission(task, app)
      await requireDispatch(authorizeDispatch, signal)
      launchAttempted = true
      onLaunch()
      task.launchToVerify = { app, windowHint }
      await this.apps.launch(app, signal)
      roots = await this.waitForWindow(app, signal)
    }
    const pinned = current && windowHint === undefined ? roots.find(window => sameWindow(current.root, window)) : undefined
    let root: WindowsAppWindow
    try {
      root = await this.selectRoot(task, pinned ? [pinned] : roots, windowHint, launchAttempted, signal)
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

  private selectRoot(task: Task, roots: WindowsAppWindow[], windowHint: string | undefined, launchAttempted: boolean, signal: AbortSignal) {
    const matches = windowHint ? matchDocuments(roots, windowHint) : roots
    if (!matches.length) throw new TargetError(launchAttempted
      ? "已请求启动应用，但尚未找到与任务匹配的窗口或文档。"
      : "应用正在运行，但没有与提示匹配的窗口或已打开文档。")
    const usable = matches.filter(window => !window.blocked)
    if (!usable.length)
      throw new TargetPausedError("目标窗口被对话框阻挡。请先在 Windows 中处理该对话框，再继续。")
    return this.choose(usable, (candidate, index) => this.windowLabel(candidate, index), signal, task.run.sessionId)
  }

  private unavailableMessage(error: WindowsAppUnavailableError): string {
    if (error.reason === "app_changed") return "Windows 应用的身份已变化。请按应用名称重新查找。"
    if (error.reason === "desktop_unavailable") return "Windows 桌面当前不可用。请解锁或回到桌面后重试。"
    return "Windows 限制了当前窗口。请检查应用是否以管理员身份运行，或是否显示系统安全提示。"
  }

  private findTask(sessionId: string, runId?: string): Task | undefined {
    const task = this.task
    return task?.run.sessionId === sessionId && (runId === undefined || task.run.runId === runId) ? task : undefined
  }

  private publish(task: Task, phase?: DesktopComputerActivity["phase"]): void {
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

  private stopTask(task: Task): void {
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

  private pauseTask(task: Task, reason: string): void {
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

  private invalidateTaskImage(task: Task): void {
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

  private async waitUntilResumed(task: Task, signal: AbortSignal): Promise<void> {
    while (task.paused) {
      const waiting = AbortSignal.any([signal, task.paused.signal])
      if (!waiting.aborted) await new Promise<void>(resolve => waiting.addEventListener("abort", () => resolve(), { once: true }))
      signal.throwIfAborted()
    }
    signal.throwIfAborted()
  }

  private releaseInput(task: Task, keepGrant = false): Promise<boolean> {
    const occupied = task.occupation
    const input = occupied?.input
    if (occupied) occupied.input = undefined
    if (!keepGrant) {
      task.occupation = undefined
      occupied?.grant.abort()
    }
    if (input) {
      const closing = input.lease?.release() ?? input.opening?.then(lease => lease.release(), (error: unknown) =>
        error instanceof WindowsForegroundStartError ? error.cleanup : undefined)
      input.stop.abort()
      const previous = this.inputCleanup
      this.inputCleanup = Promise.all([previous, closing]).then(([clean, result]) =>
        clean && (!result || result.released && result.exited), () => false)
    }
    return this.inputCleanup
  }

  private async enterInput(task: Task, occupied: Occupation, signal: AbortSignal): Promise<WindowsForegroundLease> {
    if (!this.foreground || !await this.inputCleanup || task.occupation !== occupied) {
      throw new TargetError("前台控制尚未就绪，或上次的输入释放未能确认。")
    }
    signal.throwIfAborted()
    const input: NonNullable<Occupation["input"]> = { stop: new AbortController() }
    occupied.input = input
    const lifetime = AbortSignal.any([task.stop.signal, occupied.grant.signal, input.stop.signal])
    const cancelStartup = () => input.stop.abort()
    signal.addEventListener("abort", cancelStartup, { once: true })
    try {
      input.opening = this.foreground.enter(occupied.target.window, reason => {
        if (task.occupation !== occupied || occupied.input !== input) return
        if (reason === "emergency_stop") {
          this.stopTask(task)
          this.interaction.emergencyStop?.(task.run.sessionId, task.run.runId)
          return
        }
        this.pauseTask(task, reason === "focus_lost" ? "目标窗口已失焦。" : "前台控制已结束，请确认目标窗口后继续。")
      }, lifetime)
      const lease = await input.opening
      lifetime.throwIfAborted()
      signal.throwIfAborted()
      input.lease = lease
      this.publish(task)
      return lease
    } finally {
      signal.removeEventListener("abort", cancelStartup)
    }
  }

  private requireTarget(task: Task): Target {
    if (!task.target) throw new TargetError("请先找到并打开本次任务的目标应用。")
    return task.target
  }

  private async captureWindow(task: Task, signal: AbortSignal): Promise<ComputerResult> {
    if (!this.foreground || task.capture.signal.aborted) throw new TargetError("本次任务的窗口画面未启用。")
    if (await task.imageRevocation === false) throw new TargetError("无法确认上一次截图已撤回。")
    const target = this.requireTarget(task)
    const active = AbortSignal.any([signal, task.capture.signal])
    task.frame = undefined
    await this.liveTarget(task, target, active)
    this.publish(task, task.occupation?.input?.lease ? "foreground" : "observing")
    const image = await this.foreground.capture(target.window, active).catch(() => {
      active.throwIfAborted()
      throw new TargetPausedError("当前画面无法安全读取。请先检查目标窗口，再继续。")
    })
    await this.liveTarget(task, target, active)
    active.throwIfAborted()
    const ref = `frame_${randomUUID()}`
    const { mimeType, data, width, height } = image
    task.frame = { ref, target, image, capturedAt: Date.now() }
    task.activity = { action: "观察窗口画面", evidence: "已核对目标窗口" }
    this.publish(task)
    return {
      text: JSON.stringify({ status: "captured", ...this.targetDetails(target), frame: { ref, width, height } }),
      image: { mediaType: mimeType, data, width, height },
    }
  }

  private async beginForeground(task: Task, signal: AbortSignal, approve?: ApproveAction, dispatch?: ApproveDispatch): Promise<ComputerResult> {
    if (!this.foreground || !this.interaction.armEmergencyStop) throw new TargetError("当前 Desktop 未提供可用的前台控制和本机急停。")
    if (task.occupation) throw new TargetError("目标窗口的前台控制已获准。请先观察当前界面。")
    const target = this.requireTarget(task)
    await this.liveTarget(task, target, signal)
    if (!await this.inputCleanup) throw new TargetError("无法确认上次输入已释放，继续前请重启 Desktop。")
    task.frame = undefined
    task.observation = undefined
    const occupied: Occupation = { grant: new AbortController(), target }
    task.occupation = occupied
    const requestSignal = AbortSignal.any([signal, occupied.grant.signal])
    try {
      if (!this.interaction.armEmergencyStop(task.run.sessionId, task.run.runId, task.stop.signal)) {
        throw new TargetError("无法启用本机急停，前台控制未开始。")
      }
      task.activity = { action: "等待前台控制授权", reason: `可用 ${COMPUTER_STOP_SHORTCUT} 本机急停。` }
      this.publish(task)
      if (!approve || !await approve({ proposalId: randomUUID(), reason:
        `允许 Vykor 暂时使用键鼠操作「${displayTitle(target.window).slice(0, 150)}」吗？可随时接管，或按 ${COMPUTER_STOP_SHORTCUT} 停止。`,
      }, requestSignal)) throw new TargetError("本次前台控制没有获准。")
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
    task: Task, action: InputAction, signal: AbortSignal, approve?: ApproveAction, dispatch?: ApproveDispatch,
  ): Promise<ComputerHostResponse> {
    const occupied = task.occupation
    const target = task.target
    let lease = occupied?.input?.lease
    const frame = task.frame
    const observation = task.observation
    if (!this.foreground || !occupied || !target || !lease || target.ref !== occupied.target.ref) {
      throw new TargetError("请先为当前窗口取得前台控制许可，再重新观察。")
    }
    if (!frame && observation?.windowRef !== target.ref) throw new TargetError("请先重新观察前台窗口。")
    const isFresh = () => !frame || (task.frame === frame && frame.target.ref === target.ref &&
      Date.now() >= frame.capturedAt && Date.now() - frame.capturedAt <= frameLifetimeMs)
    if (!isFresh()) throw new TargetError("目标画面已变化，请重新截图后再操作。")
    if (action.type === "click" && (!frame || frame.ref !== action.frameRef || action.x < 0 || action.y < 0 ||
      action.x >= frame.image.width || action.y >= frame.image.height)) {
      throw new TargetError("点击需要当前窗口最新画面中的有效坐标。")
    }
    const focusIdentity = frame ? frame.image.focusIdentity : observation?.focusIdentity
    if (action.type !== "click" && !focusIdentity) throw new TargetError("无法核实观察时的键盘焦点。请重新观察后再操作。")
    const operationSignal = AbortSignal.any([signal, occupied.grant.signal, ...(frame ? [task.capture.signal] : [])])
    task.observation = undefined
    let attempted = false
    try {
      if (foregroundNeedsApproval(action, target.app)) {
        if (!await this.releaseInput(task, true)) throw new TargetError("无法确认输入已释放。")
        task.activity = { action: "等待操作确认" }
        this.publish(task)
        const verb = action.type === "click" ? `${action.button === "right" ? "右击" : "点击"}画面中的 (${action.x}, ${action.y})`
          : action.type === "key" ? `按下 ${[...action.modifiers ?? [], action.key].join("+")}` : "输入文字"
        if (!approve || !await approve({ proposalId: randomUUID(), reason:
          `允许在「${displayTitle(target.window).slice(0, 150)}」窗口${verb}吗？该操作可能改变应用状态。`,
        }, operationSignal)) throw new TargetError("该操作没有获得本次批准。")
        if (!isFresh()) throw new TargetError("目标画面已变化，请重新截图后再操作。")
        await this.liveTarget(task, target, operationSignal)
        lease = await this.enterInput(task, occupied, operationSignal)
        if (frame && action.type !== "click") {
          const latest = await this.foreground.capture(target.window, operationSignal)
          if (!sameCaptureEvidence(frame.image, latest)) throw new TargetError("窗口内容在确认期间已变化，请重新观察。")
        }
        if (!frame && observation) await this.useDriver(task, target, operationSignal, async driver => {
          const current = await driver.observe(operationSignal)
          if (current.focusIdentity !== focusIdentity || observationDigest(current) !== observation.digest) {
            throw new TargetError("控件状态已变化，请重新观察后再操作。")
          }
        })
      }
      if (!isFresh()) throw new TargetError("目标画面已变化，请重新截图后再操作。")
      task.frame = undefined
      await this.liveTarget(task, target, operationSignal)
      await requireDispatch(dispatch, operationSignal)
      const input = action.type === "click" ? { type: "click" as const, x: action.x, y: action.y, ...(action.button ? { button: action.button } : {}) }
        : action.type === "type_text" ? { type: "text" as const, text: action.text, focusIdentity } : { ...action, focusIdentity }
      attempted = true
      const result = await lease.perform(input, action.type === "click" ? frame?.image : undefined, operationSignal)
      if (!result.released || result.state !== "sent") {
        this.pauseTask(task, result.released ? "目标已变化或无法核实按键鼠标输入。" : "未能核实键鼠已释放。")
        return { error: "前台输入未通过核验，请检查目标窗口。", executionState: result.state === "refused" ? "not_started" : "unknown" }
      }
      if (operationSignal.aborted) return { error: "已停止前台操作，应用结果仍需核对。", executionState: "unknown" }
      task.activity = { action: action.type === "click" ? "点击" : action.type === "key" ? "按键" : "输入文字",
        evidence: "已派发成对输入，请重新观察应用结果" }
      this.publish(task)
      return { text: JSON.stringify({ status: "sent", inputReleased: true, ...this.targetDetails(target), next: "observe the application result" }) }
    } catch (error) {
      if (this.task === task && task.occupation === occupied) {
        task.frame = undefined
        await this.releaseInput(task)
      }
      if (attempted) return { error: "前台输入可能已经派发，应用结果仍需核对。", executionState: "unknown" }
      if (error instanceof TargetError || error instanceof WindowsDriverHandoffError) throw error
      throw new TargetError("前台窗口或输入状态已变化，请重新观察。")
    }
  }

  private currentTask(run: ComputerRunIdentity, connection: AbortSignal, automatic?: true): Task {
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
      this.task = { run, automatic, stop: new AbortController(), work: new AbortController(), capture: new AbortController(), allowed: new Map(), apps: new Map() }
    }
    return this.task
  }

  private hasPermission(task: Task, app: WindowsApp): boolean {
    const grant = task.allowed.get(app.id)
    return grant === "task" || (grant === "remembered" && this.interaction.isRememberedApp?.(app.id) === true)
  }

  private assertPermission(task: Task, app: WindowsApp): void {
    if (!this.hasPermission(task, app)) throw new TargetError("此应用的许可已撤销。请重新授权后继续。")
  }

  private async waitForWindow(app: WindowsApp, signal: AbortSignal): Promise<WindowsAppWindow[]> {
    const deadline = AbortSignal.timeout(launchWaitMs)
    const waiting = AbortSignal.any([deadline, signal])
    try {
      for (;;) {
        waiting.throwIfAborted()
        const windows = primaryWindows(await this.apps.windows(app, waiting))
        if (windows.length) return windows
        await delay(250, undefined, { signal: waiting })
      }
    } catch (error) {
      if (deadline.aborted && !signal.aborted) {
        throw new TargetError("已请求启动应用，但在等待时间内没有找到可用窗口。请检查任务栏或系统提示。")
      }
      throw error
    }
  }

  private async bind(
    task: Task, app: WindowsApp, root: WindowsAppWindow, signal: AbortSignal,
    allowRetitle = false,
  ): Promise<Target> {
    const previous = task.target
    task.target = undefined
    task.observation = undefined
    this.assertPermission(task, app)
    let fresh = await this.apps.windows(app, signal)
    signal.throwIfAborted()
    let refreshedRoot = fresh.find(window => sameWindow(root, window))
    if (!refreshedRoot && allowRetitle) {
      const renamed = fresh.find(window => sameWindowInstance(root, window) && root.document === window.document)
      if (renamed && !renamed.blocked && !root.document) {
        await this.choose([renamed], (candidate, index) => this.windowLabel(candidate, index), signal, task.run.sessionId, true)
        fresh = await this.apps.windows(app, signal)
        signal.throwIfAborted()
        refreshedRoot = fresh.find(window => sameWindow(renamed, window))
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
    const pinned = previous && sameWindow(previous.root, root)
      ? usable.find(window => sameWindow(previous.window, window)) : undefined
    const selected = pinned ?? (usable.length
      ? await this.choose(usable, (window, index) => this.windowLabel(window, index), signal, task.run.sessionId)
      : refreshedRoot)
    if (!pinned && usable.length > 1) {
      const confirmed = await this.apps.windows(app, signal)
      signal.throwIfAborted()
      if (!confirmed.some(window => !window.blocked && sameWindow(refreshedRoot, window)) ||
          !confirmed.some(window => !window.blocked && sameWindow(selected, window))) {
        throw new TargetError("所选对话框已变化。请重新查找目标。")
      }
    }
    this.assertPermission(task, app)
    let appRef = [...task.apps].find(([, candidate]) => candidate.id === app.id)?.[0]
    if (!appRef) {
      appRef = `app_${randomUUID()}`
      task.apps.set(appRef, app)
    }
    const ref = previous && sameWindow(previous.window, selected) ? previous.ref : `window_${randomUUID()}`
    if (previous && previous.ref !== ref) {
      this.invalidateTaskImage(task)
      if (await task.imageRevocation === false) throw new TargetError("无法确认上一次截图已撤回。")
      signal.throwIfAborted()
    }
    if (task.occupation && task.occupation.target.ref !== ref) {
      await this.releaseInput(task)
      signal.throwIfAborted()
    }
    const target = { app, root, window: selected, appRef, ref }
    task.target = target
    return target
  }

  private ready(target: Target, source: "reused" | "launched"): ComputerResult {
    return { text: JSON.stringify({ status: "ready", ...this.targetDetails(target), source }) }
  }

  private targetDetails(target: Target) {
    return {
      app: { name: target.app.name, ref: target.appRef },
      window: { title: displayTitle(target.window), ref: target.ref, kind: target.window.ownerWindowId === undefined ? "window" : "dialog" },
    }
  }

  private observed(
    task: Task, target: Target, state: WindowsDriverObservation, details: { status: string; evidence?: string },
  ): ComputerResult {
    const snapshot = projectObservation(target.ref, state)
    task.observation = snapshot
    task.activity = details.status === "observed"
      ? { action: "观察控件", evidence: "已核对目标窗口" }
      : { action: "控件操作", evidence: details.status === "observed_change" ? "观察到界面变化" : "已读回控件结果" }
    this.publish(task)
    return { text: JSON.stringify({
      ...details, ...this.targetDetails(target), observation: snapshot.display,
    }) }
  }

  private async liveTarget(task: Task, target: Target, signal: AbortSignal, allowRetitle = false): Promise<Target> {
    signal.throwIfAborted()
    if (this.task !== task || task.target !== target) throw new TargetError("窗口许可已变化。请重新观察。")
    this.assertPermission(task, target.app)
    const windows = await this.apps.windows(target.app, signal)
    signal.throwIfAborted()
    this.assertPermission(task, target.app)
    const match = allowRetitle
      ? (expected: WindowsAppWindow, actual: WindowsAppWindow) => sameWindowInstance(expected, actual) && expected.document === actual.document
      : sameWindow
    const root = windows.find(current => !current.blocked && match(target.root, current))
    const window = windows.find(current => !current.blocked && match(target.window, current))
    if (!root || !window || (window.ownerWindowId === undefined &&
        windows.some(current => current.ownerWindowId === root.windowId))) {
      throw new TargetError("目标窗口、文档或对话框已改变。请重新观察后再操作。")
    }
    return { ...target, root, window }
  }

  private async useDriver<T>(
    task: Task, target: Target, signal: AbortSignal, work: (driver: WindowsDriver) => Promise<T>,
  ): Promise<T> {
    if (!this.openDriver) throw new TargetError("Windows 控件驱动不可用。")
    await this.liveTarget(task, target, signal)
    const driver = await this.openDriver(target.window, signal)
    try {
      signal.throwIfAborted()
      await this.liveTarget(task, target, signal)
      return await work(driver)
    } finally {
      await driver.close()
    }
  }

  private async applySemanticAction(
    task: Task, action: ComputerSemanticAction, signal: AbortSignal, approve?: ApproveAction, authorizeDispatch?: ApproveDispatch,
  ): Promise<ComputerHostResponse> {
    const { target, observation } = task
    const expected = observation?.elements.get(action.elementRef)
    if (!target || !observation || observation.windowRef !== target.ref || !expected || !supportsAction(expected, action)) {
      throw new TargetError("控件引用已过期或不支持该操作。请重新观察窗口。")
    }
    task.observation = undefined
    const prepare = async (driver: WindowsDriver) => {
      const state = await driver.observe(signal)
      const control = findControl(expected, state)
      if (!control || !supportsAction(control, action) || observationDigest(state) !== observation.digest) {
        throw new TargetError("控件或窗口状态已变化。请重新观察后再操作。")
      }
      return { state, control }
    }
    const requiresApproval = needsApproval(action, expected, target.app.builtIn === "notepad")
    if (requiresApproval) {
      const prior = await this.useDriver(task, target, signal, prepare)
      if (alreadySatisfied(action, prior.control)) {
        await requireDispatch(authorizeDispatch, signal)
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
        await requireDispatch(authorizeDispatch, signal)
        if (alreadySatisfied(action, control)) return this.observed(task, target, state, { status: "already_satisfied" })
        const { elementRef: _ref, ...operation } = action
        dispatched = true
        await driver.act({ ...operation, token: control.token }, signal)
        accepted = true
        const live = await this.liveTarget(task, target, signal, action.type === "set_text")
        const result = await driver.observe(signal)
        const verified = await this.liveTarget(task, target, signal, action.type === "set_text")
        if (!sameWindow(live.window, verified.window)) throw new TargetError("读回期间目标窗口已变化。")
        const evidence = verifiedEffect(action, control, state, result)
        if (!evidence) throw new TargetError("已派发操作，但读回未能核实它的效果。请重新观察后再决定是否重试。")
        task.target = verified
        return this.observed(task, verified, result, { status: evidence === "controls_changed" ? "observed_change" : "verified", evidence })
      })
    } catch (error) {
      if (error instanceof WindowsDriverHandoffError && accepted) {
        this.pauseTask(task, error.message)
        return { error: error.message + " 已派发的动作仍需核对结果。", executionState: "unknown" }
      }
      if (!dispatched || (error instanceof WindowsDriverError && !accepted)) throw error
      return {
        error: error instanceof TargetError ? error.message : "已派发操作，但无法核实结果。请重新观察窗口。",
        executionState: "unknown",
      }
    }
  }

  private windowLabel(window: WindowsAppWindow, index: number) {
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

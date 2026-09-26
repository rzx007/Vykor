export interface RunStallWatchdogOptions {
  runId: string
  sessionId: string
  /** 超过该毫秒数没有任何 run/task 更新就判定停滞。 */
  staleMs: number
  /** 检查周期（毫秒）。 */
  intervalMs: number
  now?(): number
  setInterval?(handler: () => void, ms: number): ReturnType<typeof setInterval>
  clearInterval?(handle: ReturnType<typeof setInterval>): void
  readActivity(): { runUpdatedAt: number; taskUpdatedAt: number }
  /** 当前模型等待重试的截止时间；期间不应判定停滞。 */
  readModelRetryDeadline?(): number | undefined
  hasPendingPermission(): boolean
  hasRunningChildTask(): boolean
  hasRunningTool(): boolean
  onStall(): void
  log?(message: string): void
}

/**
 * run 无进展看门狗：只在「run 与关联 task 都没有更新」且没有等待用户授权、
 * 没有运行中的子任务或工具时判停。触发一次后自我 dispose，避免重复中断。
 */
export class RunStallWatchdog {
  private handle?: ReturnType<typeof setInterval>
  private lastActivityAt: number
  private disposed = false

  constructor(private readonly options: RunStallWatchdogOptions) {
    this.lastActivityAt = this.now()
  }

  start(): void {
    if (this.handle || this.disposed) return
    const schedule = this.options.setInterval ?? setInterval
    this.handle = schedule(() => this.check(), this.options.intervalMs)
    ;(this.handle as { unref?: () => void }).unref?.()
  }

  check(): void {
    if (this.disposed) return
    try {
      const now = this.now()
      const activity = this.options.readActivity()
      const latest = Math.max(activity.runUpdatedAt, activity.taskUpdatedAt)
      if (latest > this.lastActivityAt) {
        this.lastActivityAt = latest
        return
      }
      if (now - this.lastActivityAt < this.options.staleMs) return
      const retryDeadline = this.options.readModelRetryDeadline?.()
      if (retryDeadline !== undefined && Number.isFinite(retryDeadline) && now < retryDeadline) {
        // 有界的合法等待：只把等待期当作「不算停滞」，截止后恢复原检测。
        this.lastActivityAt = now
        return
      }
      if (this.options.hasPendingPermission() || this.options.hasRunningChildTask() || this.options.hasRunningTool()) {
        this.lastActivityAt = now
        return
      }
      this.options.log?.(`run ${this.options.runId} made no progress for ${now - this.lastActivityAt}ms`)
      this.dispose()
      this.options.onStall()
    } catch (error) {
      // 定时器回调里抛异常会带走进程；看门狗只负责记录，然后等下一次检查。
      this.options.log?.(
        `run ${this.options.runId} stall check failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.handle) {
      (this.options.clearInterval ?? clearInterval)(this.handle)
      this.handle = undefined
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }
}

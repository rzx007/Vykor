import type { DesktopSessionRun } from "@shared/session-types"

export type TaskTiming = Pick<DesktopSessionRun, "status" | "startedAt" | "finishedAt"> & {
  interruptionSource?: "user"
  cancelledBeforeStart?: boolean
}

export function taskTiming(runs: readonly DesktopSessionRun[]): TaskTiming | undefined {
  if (runs.length === 0) return undefined
  const active =
    runs.find((run) => run.status === "running") ?? runs.find((run) => run.status === "pending")
  const starts = runs.flatMap((run) => (Number.isFinite(run.startedAt) ? [run.startedAt!] : []))
  const latest = runs.reduce((last, run) => (run.createdAt >= last.createdAt ? run : last))
  const interruption = latest.metadata.interruption as
    { source?: unknown; runId?: unknown; wasPending?: unknown } | undefined
  const cancellation = latest.metadata.cancellation as { kind?: unknown } | undefined
  const userStopped =
    latest.status === "interrupted" &&
    ((interruption?.source === "user" && interruption.runId === latest.id) ||
      cancellation?.kind === "user_cancelled_pending")
  const source = userStopped
    ? {
        interruptionSource: "user" as const,
        cancelledBeforeStart:
          starts.length === 0 &&
          (interruption?.wasPending === true || cancellation?.kind === "user_cancelled_pending"),
      }
    : {}
  if (
    !active &&
    runs.some(
      (run) =>
        !Number.isFinite(run.startedAt) ||
        !Number.isFinite(run.finishedAt) ||
        run.finishedAt! < run.startedAt!
    )
  )
    return latest.status === "interrupted" ? { status: latest.status, ...source } : undefined
  // 一次输入可能对应多个运行：统计从首次开始到最终结束的总历时，不累加并行耗时。
  return {
    status: active?.status ?? latest.status,
    ...(!active ? source : {}),
    ...(starts.length > 0 ? { startedAt: Math.min(...starts) } : {}),
    ...(!active ? { finishedAt: Math.max(...runs.map((run) => run.finishedAt!)) } : {}),
  }
}

/** 折叠标题与状态行共用同一套终态文案；不从错误文本猜测是谁停止的。 */
export function taskTimingLabel(timing: TaskTiming): string | undefined {
  const valid =
    Number.isFinite(timing.startedAt) &&
    Number.isFinite(timing.finishedAt) &&
    timing.finishedAt! >= timing.startedAt!
  const elapsed = valid ? formatElapsedTime(timing.finishedAt! - timing.startedAt!) : undefined
  if (timing.status === "interrupted") {
    if (timing.interruptionSource === "user") {
      if (timing.cancelledBeforeStart) return "你取消了等待中的任务"
      return elapsed ? `你在 ${elapsed}后停止了` : "你停止了本次执行"
    }
    return elapsed ? `执行在 ${elapsed}后中断` : "执行已中断"
  }
  if (timing.status === "failed") return elapsed ? `执行失败，用时 ${elapsed}` : "执行失败"
  if (timing.status === "completed" && elapsed) return `用时 ${elapsed}`
  return undefined
}

export function formatElapsedTime(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000))
  if (seconds < 1) return "不足1秒"
  if (seconds < 60) return `${seconds}秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}分${seconds % 60}秒`
  return `${Math.floor(minutes / 60)}小时${minutes % 60}分${seconds % 60}秒`
}

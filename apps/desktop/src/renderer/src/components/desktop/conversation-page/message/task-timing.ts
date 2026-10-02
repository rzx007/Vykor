import type { DesktopSessionRun } from "@shared/session-types"

export type TaskTiming = Pick<DesktopSessionRun, "status" | "startedAt" | "finishedAt">

export function taskTiming(runs: readonly DesktopSessionRun[]): TaskTiming | undefined {
  if (runs.length === 0) return undefined
  const active =
    runs.find((run) => run.status === "running") ?? runs.find((run) => run.status === "pending")
  const starts = runs.flatMap((run) => (Number.isFinite(run.startedAt) ? [run.startedAt!] : []))
  if (
    !active &&
    runs.some(
      (run) =>
        !Number.isFinite(run.startedAt) ||
        !Number.isFinite(run.finishedAt) ||
        run.finishedAt! < run.startedAt!
    )
  )
    return undefined
  const latest = runs.reduce((last, run) => (run.createdAt >= last.createdAt ? run : last))
  // 一次输入可能对应多个运行：统计从首次开始到最终结束的总历时，不累加并行耗时。
  return {
    status: active?.status ?? latest.status,
    ...(starts.length > 0 ? { startedAt: Math.min(...starts) } : {}),
    ...(!active ? { finishedAt: Math.max(...runs.map((run) => run.finishedAt!)) } : {}),
  }
}

export function formatElapsedTime(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000))
  if (seconds < 1) return "不足1秒"
  if (seconds < 60) return `${seconds}秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}分${seconds % 60}秒`
  return `${Math.floor(minutes / 60)}小时${minutes % 60}分${seconds % 60}秒`
}

import { useEffect, useState } from "react"
import { LoadingState } from "@renderer/components/ui/loading-state"
import { formatElapsedTime, type TaskTiming } from "./task-timing"

export function ElapsedTime({
  startedAt,
  finishedAt,
  running = false,
  prefix = "",
}: {
  startedAt?: number
  finishedAt?: number
  running?: boolean
  prefix?: string
}): React.JSX.Element | null {
  const [now, setNow] = useState(() => Date.now())
  const ticking = running && Number.isFinite(startedAt)
  useEffect(() => {
    if (!ticking) return
    // 定时器只刷新当前时间；耗时始终由已保存的时间点计算。
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [ticking, startedAt])
  const end = running ? now : finishedAt
  if (!Number.isFinite(startedAt) || !Number.isFinite(end)) return null
  if (!running && end! < startedAt!) return null
  return (
    <span className="text-ui-caption shrink-0 text-ui-muted tabular-nums">
      {prefix}
      {formatElapsedTime(end! - startedAt!)}
    </span>
  )
}

export function TaskDuration({
  timing,
  label,
}: {
  timing?: TaskTiming
  label?: string
}): React.JSX.Element | null {
  if (!timing) return null
  const active = timing.status === "running" || timing.status === "pending"
  const status = timing.status === "pending" ? "等待执行" : (label ?? "进行中")
  const finishedLabel =
    timing.status === "interrupted"
      ? "已中断 · 运行了"
      : timing.status === "failed"
        ? "失败 · 运行了"
        : "耗时"
  return (
    <div data-task-duration className="text-ui-caption mt-2 flex items-center gap-2 text-ui-muted">
      {active ? (
        <LoadingState label={status} variant="Dots" showElapsed={false} />
      ) : (
        <span>{finishedLabel}</span>
      )}
      <ElapsedTime
        key={`${timing.startedAt}:${active}`}
        startedAt={timing.startedAt}
        finishedAt={timing.finishedAt}
        running={active}
      />
    </div>
  )
}

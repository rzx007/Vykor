import { useEffect, useState } from "react"
import { LoadingState } from "@renderer/components/ui/loading-state"
import { formatElapsedTime, taskTimingLabel, type TaskTiming } from "./task-timing"

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
  placement = "footer",
}: {
  timing?: TaskTiming
  label?: string
  placement?: "header" | "footer"
}): React.JSX.Element | null {
  if (!timing) return null
  const active = timing.status === "running" || timing.status === "pending"
  const status = label ?? (timing.status === "pending" ? "等待执行" : "进行中")
  const finishedLabel = taskTimingLabel(timing)
  if (!active && !finishedLabel) return null
  return (
    <div
      data-task-duration
      className={
        placement === "header"
          ? "text-chat border-workspace mb-6 border-b pb-2 text-ui-muted"
          : "text-ui-caption mt-2 flex items-center gap-2 text-ui-muted"
      }
    >
      {active ? (
        <>
          <LoadingState label={status} variant="Dots" showElapsed={false} />
          <ElapsedTime key={`${timing.startedAt}:${active}`} startedAt={timing.startedAt} running />
        </>
      ) : (
        <span>{finishedLabel}</span>
      )}
    </div>
  )
}

import { useState, type KeyboardEvent } from "react"
import {
  DonutChart,
  DonutChartCenter,
  DonutChartLegend,
  DonutChartPlot,
} from "@renderer/components/charts/donut-chart"
import { cn } from "@renderer/lib/utils"
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  CardFooter,
} from "@renderer/components/motion/card"
import { Tabs } from "@renderer/components/motion/tabs"
import { UsageHelp, UsageTabPanels, UsageTabsList, UsageAnimatedValue } from "./usage-ui"
import {
  formatCount,
  formatTokens,
  groupUsage,
  type UsageAnalytics,
  type UsageMetric,
} from "./usage-analytics"

const colors = [
  "var(--primary)",
  "color-mix(in oklab, var(--foreground) 70%, var(--background))",
  "color-mix(in oklab, var(--foreground) 50%, var(--background))",
  "color-mix(in oklab, var(--foreground) 35%, var(--background))",
  "color-mix(in oklab, var(--foreground) 22%, var(--background))",
]

function scaleMaximum(value: number) {
  if (!value) return 0
  const step = Math.max(1, 10 ** Math.floor(Math.log10(value / 4)))
  const tick = [1, 2, 2.5, 5, 10].map((n) => n * step).find((n) => n * 4 > value) ?? step * 10
  return Math.ceil(tick) * 4
}

export function UsageTrend({
  analytics,
  metric,
  onMetricChange,
}: {
  analytics: UsageAnalytics
  metric: UsageMetric
  onMetricChange: (metric: UsageMetric) => void
}) {
  const { buckets, interval } = analytics
  const [activeTime, setActiveTime] = useState<number | null>(null)
  const active = buckets.find((bucket) => bucket.time === activeTime)
  const values = buckets.map((bucket) => bucket[metric])
  const maximum = scaleMaximum(Math.max(0, ...values.map((value) => value ?? 0)))
  const peak = buckets.reduce<(typeof buckets)[number] | undefined>(
    (best, bucket) => ((bucket[metric] ?? 0) > (best?.[metric] ?? 0) ? bucket : best),
    undefined
  )
  const unit = metric === "tokens" ? "Token" : "条记录"
  const intervalLabel = { hour: "小时", day: "天", month: "月" }[interval]
  const tickEvery = Math.max(1, Math.ceil(buckets.length / 6))
  const inspectByKeyboard = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next =
      event.key === "ArrowRight"
        ? Math.min(buckets.length - 1, index + 1)
        : event.key === "ArrowLeft"
          ? Math.max(0, index - 1)
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? buckets.length - 1
              : -1
    if (next < 0) return
    event.preventDefault()
    event.currentTarget.parentElement
      ?.querySelectorAll<HTMLButtonElement>("[data-usage-bar]")
      [next]?.focus()
  }
  const options = [
    { id: "tokens", label: "Token" },
    { id: "requests", label: "请求记录" },
  ]
  return (
    <Tabs
      value={metric}
      onValueChange={(value) => {
        if (value === "tokens" || value === "requests") onMetricChange(value)
      }}
      variant="pill"
      className="h-full min-w-0"
    >
      <Card
        id="usage-trend"
        role="region"
        aria-labelledby="usage-trend-heading"
        size="compact"
        className="h-full min-w-0 gap-3 border-border/70"
      >
        <CardHeader className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1">
            <CardTitle as="h2" id="usage-trend-heading">
              用量趋势
            </CardTitle>
            <UsageHelp label="用量趋势说明">
              <p>
                按本地时区分组，柱形高度表示真实数值。悬停或聚焦柱形查看数值，方向键和 Home、End
                切换时间点。
              </p>
              <p>未知用量不画成已测得的零，请求记录可能不完整。</p>
            </UsageHelp>
          </div>
          <UsageTabsList label="趋势统计指标" options={options} />
        </CardHeader>
        <CardContent className="flex-1">
          <UsageTabPanels value={metric} options={options}>
            <div className="mb-4 flex min-h-5 flex-wrap items-center justify-between gap-2 text-xs">
              <span className="text-muted-foreground">按{intervalLabel}</span>
              <span className="text-right tabular-nums" aria-live="polite">
                {active
                  ? active.label +
                    " · " +
                    (active[metric] === null
                      ? "用量未知"
                      : formatCount(active[metric]!) + " " + unit)
                  : peak
                    ? "峰值 " + peak.label + " · " + formatTokens(peak[metric]) + " " + unit
                    : analytics.totals.requests && analytics.totals.tokens === 0
                      ? "已知 Token 为 0"
                      : "暂无已知用量"}
              </span>
            </div>
            <div className="relative mt-2 pl-12">
              <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-44">
                {(maximum ? [4, 3, 2, 1, 0] : [0]).map((tick) => (
                  <div
                    key={tick}
                    className="absolute right-0 left-0 flex items-center gap-2"
                    style={{ top: `${maximum ? (1 - tick / 4) * 100 : 100}%` }}
                  >
                    <span className="w-10 shrink-0 text-right text-[11px] leading-none text-muted-foreground tabular-nums">
                      {formatTokens((maximum * tick) / 4)}
                    </span>
                    <span className="h-px flex-1 bg-border/60" />
                  </div>
                ))}
              </div>
              <div
                role="group"
                aria-label={`按${intervalLabel}的${metric === "tokens" ? "Token 用量" : "请求记录"}，方向键可切换时间`}
                className="relative flex h-44 items-end gap-1"
                onPointerLeave={() => setActiveTime(null)}
              >
                {buckets.map((bucket, index) => {
                  const value = bucket[metric]
                  const label = `${new Date(bucket.time).toLocaleString()}，${value === null ? "用量未知" : `${formatCount(value)} ${unit}`}，输入 ${formatTokens(bucket.input)}，输出 ${formatTokens(bucket.output)}，${bucket.unknown} 条未知，${bucket.partial} 条部分记录`
                  return (
                    <button
                      key={bucket.time}
                      type="button"
                      data-usage-bar
                      aria-label={label}
                      title={label}
                      tabIndex={
                        active
                          ? active.time === bucket.time
                            ? 0
                            : -1
                          : index === buckets.length - 1
                            ? 0
                            : -1
                      }
                      onFocus={() => setActiveTime(bucket.time)}
                      onBlur={() => setActiveTime(null)}
                      onPointerEnter={() => setActiveTime(bucket.time)}
                      onClick={() => setActiveTime(bucket.time)}
                      onKeyDown={(event) => inspectByKeyboard(event, index)}
                      className={cn(
                        "relative flex h-full min-w-0 flex-1 items-end justify-center rounded-t-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                        active?.time === bucket.time && "bg-muted/60"
                      )}
                    >
                      {value === null ? (
                        <span aria-hidden="true" className="mb-1 text-xs text-muted-foreground">
                          —
                        </span>
                      ) : value > 0 && maximum > 0 ? (
                        <span
                          aria-hidden="true"
                          className="flex w-full max-w-10 flex-col justify-end overflow-hidden rounded-t-sm"
                          style={{ height: `${(value / maximum) * 100}%` }}
                        >
                          {metric === "tokens" ? (
                            <>
                              <span
                                className="w-full bg-foreground/35"
                                style={{ height: `${((bucket.output ?? 0) / value) * 100}%` }}
                              />
                              <span
                                className="w-full bg-primary"
                                style={{ height: `${((bucket.input ?? 0) / value) * 100}%` }}
                              />
                            </>
                          ) : (
                            <span className="h-full w-full bg-primary" />
                          )}
                        </span>
                      ) : null}
                    </button>
                  )
                })}
                {!maximum && (
                  <p className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">
                    {analytics.totals.requests
                      ? analytics.totals.tokens === 0
                        ? "当前范围的已知 Token 为 0"
                        : "当前记录没有可绘制的用量"
                      : "当前范围没有请求记录"}
                  </p>
                )}
              </div>
              <div
                aria-hidden="true"
                className="mt-3 flex gap-1 text-[11px] text-muted-foreground tabular-nums"
              >
                {buckets.map((bucket, index) => (
                  <span key={bucket.time} className="min-w-0 flex-1 text-center whitespace-nowrap">
                    {index % tickEvery === 0 ? bucket.label : ""}
                  </span>
                ))}
              </div>
            </div>
          </UsageTabPanels>
        </CardContent>
        <CardFooter className="min-h-6 gap-4 text-xs text-muted-foreground">
          {metric === "tokens" ? (
            <>
              <span className="inline-flex items-center gap-1.5">
                <span className="size-2 rounded-sm bg-primary" />
                输入
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="size-2 rounded-sm bg-foreground/35" />
                输出
              </span>
            </>
          ) : (
            <span>请求记录</span>
          )}
        </CardFooter>
      </Card>
    </Tabs>
  )
}

export function UsageDistribution({
  analytics,
  metric,
}: {
  analytics: UsageAnalytics
  metric: UsageMetric
}) {
  const [by, setBy] = useState<"model" | "provider">("model")
  const groups = groupUsage(analytics.rows, by, metric)
  const unit = metric === "tokens" ? "Token" : "条记录"
  const options = [
    { id: "model", label: "模型" },
    { id: "provider", label: "供应商" },
  ]
  return (
    <Tabs
      value={by}
      onValueChange={(value) => {
        if (value === "model" || value === "provider") setBy(value)
      }}
      variant="pill"
      className="h-full min-w-0"
    >
      <Card
        id="usage-distribution"
        role="region"
        aria-labelledby="usage-distribution-heading"
        size="compact"
        className="h-full min-w-0 gap-3 border-border/70"
      >
        <CardHeader className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1">
            <CardTitle as="h2" id="usage-distribution-heading">
              {by === "model" ? "模型占比" : "供应商占比"}
            </CardTitle>
            <UsageHelp label="用量占比说明">
              <p>按当前筛选和指标排名，显示前四项，其余合并为“其他”。同名模型按供应商区分。</p>
              <p>悬停图形或聚焦图例查看占比，图例支持上下方向键。</p>
            </UsageHelp>
          </div>
          <UsageTabsList label="用量分组" options={options} />
        </CardHeader>
        <CardContent className="flex-1">
          <UsageTabPanels value={by} options={options}>
            {groups.length ? (
              <DonutChart
                segments={groups.map((group, index) => ({ ...group, color: colors[index] }))}
                label={`${by === "model" ? "模型" : "供应商"}${unit}占比`}
                thickness={12}
                gap={3}
                formatValue={formatTokens}
                className="mt-2 grid items-start gap-3 @min-[420px]:grid-cols-[7rem_minmax(0,1fr)] @min-[760px]:grid-cols-1 @min-[1000px]:grid-cols-[7rem_minmax(0,1fr)]"
              >
                <DonutChartPlot className="w-28">
                  <DonutChartCenter>
                    {(segment, total) => (
                      <>
                        <p
                          className="text-lg font-medium tabular-nums"
                          title={`${formatCount(segment?.value ?? total)} ${unit}`}
                        >
                          <UsageAnimatedValue value={segment?.value ?? total} />
                        </p>
                        <p className="mt-1 text-[11px] text-muted-foreground">
                          {segment ? `${(segment.share * 100).toFixed(1)}%` : unit}
                        </p>
                      </>
                    )}
                  </DonutChartCenter>
                </DonutChartPlot>
                <DonutChartLegend
                  className="min-w-0 space-y-0 [&_button]:rounded-lg [&_button]:px-2 [&_button]:py-1.5 [&_button>span:first-child]:gap-2 [&_button>span:last-child]:mt-1 [&_button>span:last-child]:ml-4.5 [&_button>span:last-child]:h-0.5 [&_button>span>span]:text-xs"
                  renderDetail={(segment) => (
                    <span
                      className="block truncate"
                      title={`${segment.name} · ${groups.find((group) => group.id === segment.id)?.detail ?? ""} · ${formatCount(segment.value)} ${unit}`}
                    >
                      {groups.find((group) => group.id === segment.id)?.detail}
                      {by === "model" ? " · " : ""}
                      {formatTokens(segment.value)} {unit}
                    </span>
                  )}
                  renderValue={(segment) => (
                    <span title={`${formatCount(segment.value)} ${unit}`}>
                      {(segment.share * 100).toFixed(1)}%
                    </span>
                  )}
                />
              </DonutChart>
            ) : (
              <div className="flex min-h-48 items-center justify-center text-center text-xs text-muted-foreground">
                {analytics.totals.requests
                  ? analytics.totals.tokens === 0
                    ? "已知 Token 为 0"
                    : "未提供 Token 用量"
                  : "暂无请求记录"}
              </div>
            )}
          </UsageTabPanels>
        </CardContent>
      </Card>
    </Tabs>
  )
}

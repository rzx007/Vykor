import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Download, RefreshCw } from "lucide-react"
import { OverflowActions } from "@renderer/components/motion/overflow-actions"
import { Button } from "@renderer/components/ui/button"
import { Input } from "@renderer/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@renderer/components/ui/select"
import { Skeleton } from "@renderer/components/ui/skeleton"
import { toast } from "@renderer/lib/toast"
import type {
  MaintenanceSettingsAPI,
  UsageFilter,
  UsageReport,
} from "@shared/maintenance-settings-types"
import { errorMessage } from "../shared/settings-error-message"
import {
  buildUsageAnalytics,
  formatCount,
  formatDateInput,
  formatTokens,
  resolveUsageWindow,
  type UsageMetric,
  type UsageWindow,
} from "./usage-analytics"
import { UsageDistribution, UsageTrend } from "./usage-charts"
import { UsageRequestTable } from "./usage-request-table"
import { UsageTokenBudget } from "./usage-token-budget"
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  CardFooter,
} from "@renderer/components/motion/card"
import { Tabs } from "@renderer/components/motion/tabs"
import { TooltipProvider } from "@renderer/components/ui/tooltip"
import { UsageAnimatedValue, UsageHelp, UsageTabsList, UsageTabPanels } from "./usage-ui"

// eslint-disable-next-line react-refresh/only-export-components -- 已有维护 API 入口同时被存储和诊断页面使用。
export function maintenanceApi(): MaintenanceSettingsAPI {
  const api = (window.desktop as unknown as { maintenance?: MaintenanceSettingsAPI }).maintenance
  if (!api) throw new Error("当前应用未接入维护服务")
  return api
}

type Snapshot = { report: UsageReport; window: UsageWindow; filter: UsageFilter; key: string }
const rangeOptions = [
  { id: "1", label: "今天" },
  { id: "7", label: "最近 7 天" },
  { id: "30", label: "最近 30 天" },
  { id: "custom", label: "自定义" },
]

function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: string
  options: string[]
  onChange: (value: string) => void
}) {
  const display = (option: string) => (option === "unknown" ? "未知" : option)
  const items = [
    { value: "", label: `全部${label}` },
    ...options.map((option) => ({ value: option, label: display(option) })),
  ]
  return (
    <label className="flex min-w-0 flex-1 items-center gap-2 text-xs text-muted-foreground">
      <span className="shrink-0">{label}</span>
      <Select
        value={value}
        items={items}
        onValueChange={(next) => {
          if (typeof next === "string") onChange(next)
        }}
      >
        <SelectTrigger
          aria-label={`筛选${label}`}
          size="sm"
          className="w-full max-w-64 min-w-0 font-normal text-foreground"
          title={value || `全部${label}`}
        >
          <SelectValue>
            {items.find((item) => item.value === value)?.label ?? display(value)}
          </SelectValue>
        </SelectTrigger>
        <SelectContent alignItemWithTrigger={false} align="start">
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </label>
  )
}

function readableWarnings(warnings: string[]) {
  return [
    ...new Set(
      warnings.flatMap((warning) => {
        if (warning.includes("价格或用量超出")) return []
        if (warning.includes("未保存开始时间"))
          return ["部分历史请求缺少开始时间，按完成时间归入统计。"]
        if (warning.includes("没有逐次模型事件"))
          return ["部分历史或进行中的任务缺少逐次请求记录，按已有尝试列出；请求次数可能不完整。"]
        if (warning.includes("开始记录不证明")) return ["部分请求还未收到完成用量，暂列为未知。"]
        return [warning]
      })
    ),
  ]
}

export function UsageSettings() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [filter, setFilter] = useState<UsageFilter>({})
  const [range, setRange] = useState("7")
  const [from, setFrom] = useState("")
  const [to, setTo] = useState("")
  const [metric, setMetric] = useState<UsageMetric>("tokens")
  const [busy, setBusy] = useState(false)
  const [actionBusy, setActionBusy] = useState(false)
  const [error, setError] = useState("")
  const sequence = useRef(0)
  const queryKey = JSON.stringify([filter.project, filter.provider, filter.model, range, from, to])

  const load = useCallback(async () => {
    const current = ++sequence.current
    setBusy(true)
    try {
      const window = resolveUsageWindow(range, from, to)
      const requestFilter = { ...filter, ...window }
      const report = await maintenanceApi().usage(requestFilter)
      if (current !== sequence.current) return
      setSnapshot({ report, window, filter: requestFilter, key: queryKey })
      setError("")
    } catch (failure) {
      if (current === sequence.current) setError(errorMessage(failure))
    } finally {
      if (current === sequence.current) setBusy(false)
    }
  }, [filter, range, from, to, queryKey])

  useEffect(() => {
    let active = true
    queueMicrotask(() => {
      if (active) void load()
    })
    const timer = setInterval(() => void load(), 30_000)
    return () => {
      active = false
      // eslint-disable-next-line react-hooks/exhaustive-deps -- 这是请求版本号；卸载时必须递增当前值，使未完成的旧请求失效。
      sequence.current++
      clearInterval(timer)
    }
  }, [load])

  const analytics = useMemo(
    () => (snapshot ? buildUsageAnalytics(snapshot.report.requests, snapshot.window) : null),
    [snapshot]
  )
  const stale = !!snapshot && snapshot.key !== queryKey
  const locked = actionBusy || busy || stale
  const chooseRange = (value: string) => {
    if (value === "custom" && (!from || !to)) {
      const start = new Date()
      start.setDate(start.getDate() - 6)
      setFrom(formatDateInput(start))
      setTo(formatDateInput(new Date()))
    }
    setRange(value)
  }
  const exportUsage = async (format: "csv" | "json") => {
    if (!snapshot) return
    setActionBusy(true)
    try {
      const result = await maintenanceApi().exportUsage(snapshot.filter, format)
      if (result) toast.success("导出完成", result)
      else toast.info("导出已取消")
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setActionBusy(false)
    }
  }
  const saveBudget = async (value: Parameters<MaintenanceSettingsAPI["budget"]>[0]) => {
    setActionBusy(true)
    try {
      const settings = await maintenanceApi().budget(value)
      setSnapshot((previous) =>
        previous ? { ...previous, report: { ...previous.report, settings } } : null
      )
      toast.success(value.enabled ? "用量提醒已保存" : "用量提醒已关闭")
      setError("")
      return true
    } catch (failure) {
      setError(errorMessage(failure))
      return false
    } finally {
      setActionBusy(false)
    }
  }
  const stats: ReadonlyArray<readonly [string, number | null]> = analytics
    ? [
        ["已知 Token", analytics.totals.tokens],
        ["输入 Token", analytics.totals.input],
        ["输出 Token", analytics.totals.output],
        ["请求记录", analytics.totals.requests],
      ]
    : []

  const notes: Record<string, string> = {
    "已知 Token": "输入与输出的已知小计，缓存单独列出，不重复相加。",
    "输入 Token": "模型处理输入的已记录 Token；缺失字段不当作已测得的零。",
    "输出 Token": "模型生成输出的已记录 Token；缺失字段不当作已测得的零。",
    请求记录: "包括重试、部分及未知记录；历史缺失时，记录数可能不等于实际请求总数。",
  }
  return (
    <TooltipProvider delay={200}>
      <Tabs
        value={range}
        onValueChange={chooseRange}
        variant="underline"
        className="@container flex min-w-0 flex-col gap-4"
      >
        <Card
          id="usage-filters"
          aria-label="用量筛选"
          size="compact"
          className="gap-4 border-border/70"
        >
          <CardHeader className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-1">
                <CardTitle as="h2">用量概览</CardTitle>
                <UsageHelp label="用量统计说明">
                  <p>按本地时区统计，每 30 秒更新。所有图表、明细和导出使用同一份筛选结果。</p>
                  <p>未知字段显示为“—”；没有记录的时间段不代表没有产生用量。</p>
                  {snapshot &&
                    readableWarnings(snapshot.report.warnings).map((warning) => (
                      <p key={warning}>{warning}</p>
                    ))}
                </UsageHelp>
              </div>
              {snapshot && (
                <p className="mt-1 text-xs text-muted-foreground tabular-nums">
                  {new Date(snapshot.window.from).toLocaleDateString()} –{" "}
                  {new Date(snapshot.window.to - 1).toLocaleDateString()}
                </p>
              )}
            </div>
            <OverflowActions
              size="sm"
              primaryActions={[
                {
                  id: "refresh",
                  label: "刷新",
                  icon: (
                    <RefreshCw
                      aria-hidden="true"
                      strokeWidth={1.75}
                      className={
                        busy ? "size-3.5 animate-spin motion-reduce:animate-none" : "size-3.5"
                      }
                    />
                  ),
                  disabled: busy || actionBusy,
                  onClick: () => void load(),
                },
              ]}
              overflowActions={[
                {
                  id: "export-csv",
                  label: "导出 CSV",
                  icon: <Download aria-hidden="true" className="size-3.5" strokeWidth={1.75} />,
                  disabled: !snapshot || locked,
                  onClick: () => void exportUsage("csv"),
                },
                {
                  id: "export-json",
                  label: "导出 JSON",
                  icon: <Download aria-hidden="true" className="size-3.5" strokeWidth={1.75} />,
                  disabled: !snapshot || locked,
                  onClick: () => void exportUsage("json"),
                },
              ]}
              openLabel="更多用量操作"
              closeLabel="收起用量操作"
              className="max-w-full overflow-x-auto"
              classNames={{
                track: "shrink-0 border-border/70",
                toggle: "bg-muted text-muted-foreground hover:text-foreground",
              }}
            />
          </CardHeader>
          <CardContent>
            <UsageTabsList label="时间范围" options={rangeOptions} underline />
            <UsageTabPanels value={range} options={rangeOptions} className="space-y-5 pt-4">
              {range === "custom" && (
                <div className="flex flex-wrap items-center gap-3">
                  <label className="flex items-center gap-2 text-xs text-muted-foreground">
                    开始
                    <Input
                      aria-label="开始日期"
                      type="date"
                      className="h-8 w-40 text-foreground"
                      value={from}
                      onChange={(event) => setFrom(event.target.value)}
                    />
                  </label>
                  <label className="flex items-center gap-2 text-xs text-muted-foreground">
                    结束
                    <Input
                      aria-label="结束日期"
                      type="date"
                      className="h-8 w-40 text-foreground"
                      value={to}
                      onChange={(event) => setTo(event.target.value)}
                    />
                  </label>
                </div>
              )}
              <div className="grid grid-cols-1 gap-3 @min-[560px]:grid-cols-3">
                {(["project", "provider", "model"] as const).map((key) => (
                  <FilterSelect
                    key={key}
                    label={{ project: "项目", provider: "供应商", model: "模型" }[key]}
                    value={filter[key] ?? ""}
                    options={
                      snapshot?.report.options[
                        key === "project" ? "projects" : key === "provider" ? "providers" : "models"
                      ] ?? []
                    }
                    onChange={(value) =>
                      setFilter((previous) => ({ ...previous, [key]: value || undefined }))
                    }
                  />
                ))}
              </div>
              {error && (
                <div
                  role="alert"
                  className="flex flex-wrap items-center gap-2 text-xs text-destructive"
                >
                  <span>
                    {error}
                    {snapshot ? " 仍显示上次读取结果。" : ""}
                  </span>
                  <Button
                    size="sm"
                    shape="pill"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => void load()}
                  >
                    重试
                  </Button>
                </div>
              )}
              {stale && busy && (
                <p role="status" className="text-xs text-muted-foreground">
                  正在更新筛选结果，当前仍显示上次读取的数据。
                </p>
              )}
              {!snapshot || !analytics ? (
                error && !busy ? (
                  <p className="text-sm text-muted-foreground">暂时无法读取用量，请重试。</p>
                ) : (
                  <div
                    role="status"
                    aria-label="正在读取用量"
                    className="grid grid-cols-2 gap-6 @min-[560px]:grid-cols-4"
                  >
                    {["已知 Token", "输入", "输出", "请求记录"].map((label) => (
                      <div key={label}>
                        <p className="text-xs text-muted-foreground">{label}</p>
                        <Skeleton className="mt-3 h-7 w-24 motion-reduce:animate-none" />
                      </div>
                    ))}
                  </div>
                )
              ) : (
                <section id="usage-summary" aria-label="用量概览">
                  <dl className="grid grid-cols-2 gap-x-6 gap-y-5 @min-[560px]:grid-cols-4">
                    {stats.map(([label, value]) => (
                      <div key={label}>
                        <dt className="flex items-center gap-1 text-xs text-muted-foreground">
                          {label}
                          <UsageHelp label={label + "说明"}>
                            <p>
                              {value === null
                                ? "未提供用量"
                                : formatCount(value) + (label === "请求记录" ? " 条" : " Token")}
                            </p>
                            <p>{notes[label]}</p>
                          </UsageHelp>
                        </dt>
                        <dd
                          aria-label={value === null ? "未知" : formatTokens(value)}
                          className="mt-1 text-2xl font-medium tracking-tight tabular-nums"
                        >
                          <UsageAnimatedValue value={value} />
                        </dd>
                      </div>
                    ))}
                  </dl>
                </section>
              )}
            </UsageTabPanels>
          </CardContent>
          {snapshot && analytics && (
            <CardFooter className="flex-wrap justify-between gap-x-6 gap-y-2 border-t border-border/60 pt-3 text-xs text-muted-foreground">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 tabular-nums">
                <span>
                  缓存读取{" "}
                  <span className="ml-1 text-foreground">
                    <UsageAnimatedValue value={analytics.totals.cacheRead} />
                  </span>
                </span>
                <span>
                  缓存创建{" "}
                  <span className="ml-1 text-foreground">
                    <UsageAnimatedValue value={analytics.totals.cacheCreation} />
                  </span>
                </span>
                <span className="inline-flex items-center gap-1">
                  未知 {formatCount(analytics.totals.unknown)} · 部分{" "}
                  {formatCount(analytics.totals.partial)}
                  <UsageHelp label="缓存与记录说明">
                    <p>缓存独立显示，不再叠加到输入与输出总量。未知字段保留为“—”。</p>
                    <p>未知记录未返回完整用量，部分记录只统计已记录的字段。</p>
                  </UsageHelp>
                </span>
              </div>
              <span className="tabular-nums">
                更新于 {new Date(snapshot.report.scannedAt).toLocaleTimeString()}
              </span>
            </CardFooter>
          )}
        </Card>
        {snapshot && analytics && (
          <>
            <div className="grid min-w-0 grid-cols-1 items-stretch gap-4 @min-[760px]:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
              <UsageTrend analytics={analytics} metric={metric} onMetricChange={setMetric} />
              <UsageDistribution analytics={analytics} metric={metric} />
            </div>
            <UsageRequestTable key={snapshot.key} rows={analytics.rows} />
            <UsageTokenBudget
              budget={snapshot.report.settings.budget}
              busy={locked}
              onSave={saveBudget}
            />
          </>
        )}
      </Tabs>
    </TooltipProvider>
  )
}

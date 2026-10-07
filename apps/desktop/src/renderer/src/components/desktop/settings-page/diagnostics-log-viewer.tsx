import { useState } from "react"
import { Link } from "@tanstack/react-router"
import { Input } from "@renderer/components/ui/input"
import { Button } from "@renderer/components/ui/button"
import type { DiagnosticFilter, DiagnosticReport } from "@shared/maintenance-settings-types"
import { filterDiagnosticLogRecords } from "@shared/diagnostic-log-filter"
import { SettingsGroup, SettingsSelect, SettingsFoldout } from "./settings-group"
import { SettingsStatus } from "./settings-status"

export function DiagnosticsLogViewer({
  report,
  busy,
  detailsExpiry,
  onExport,
  onCopy,
}: {
  report: DiagnosticReport | null
  busy: boolean
  detailsExpiry: number | null
  onExport(filter: DiagnosticFilter): void
  onCopy(content: string): void
}) {
  const [filter, setFilter] = useState<DiagnosticFilter>({ level: "problems" })
  const [limit, setLimit] = useState(100)
  const allLogs = (report?.logs ?? []).map((log) => {
    if (detailsExpiry && detailsExpiry > Date.now()) return log
    const { requestId: _request, toolName: _tool, method: _method, ...basic } = log
    return basic
  })
  const logs = filterDiagnosticLogRecords(allLogs, filter)
  const unavailable = report?.missing.includes("当前服务运行日志") && !allLogs.length
  function update(patch: Partial<DiagnosticFilter>) {
    setFilter((current) => ({ ...current, ...patch }))
    setLimit(100)
  }
  return (
    <SettingsGroup
      title="运行日志"
      id="diagnostics-logs"
      action={
        <Button
          size="sm"
          variant="ghost"
          disabled={busy || !report}
          onClick={() => onExport(filter)}
        >
          导出筛选结果
        </Button>
      }
    >
      <div className="flex flex-wrap items-center gap-3">
        <Input
          className="min-w-44 flex-1"
          aria-label="搜索运行日志"
          placeholder="搜索事件、模块或任务"
          value={filter.query ?? ""}
          onChange={(event) => update({ query: event.target.value })}
        />
        <SettingsSelect
          label="日志级别"
          value={filter.level ?? "all"}
          options={[
            { value: "problems", label: "错误与警告" },
            { value: "all", label: "全部日志" },
            { value: "error", label: "仅错误" },
            { value: "warn", label: "仅警告" },
            { value: "info", label: "信息" },
            { value: "debug", label: "调试" },
          ]}
          onChange={(level) => update({ level })}
        />
      </div>
      <div className="mt-3">
        <SettingsFoldout title="更多筛选">
          <div className="settings-filter-grid">
            <label className="flex flex-col gap-2 text-sm">
              时间范围
              <select
                aria-label="日志时间范围"
                className="h-8 rounded-lg border border-input bg-background px-2"
                onChange={(event) =>
                  update({
                    from: event.target.value
                      ? Date.now() - Number(event.target.value) * 86400000
                      : undefined,
                  })
                }
              >
                <option value="">全部已读取</option>
                <option value="1">最近 24 小时</option>
                <option value="7">最近 7 天</option>
              </select>
            </label>
            <label className="flex flex-col gap-2 text-sm">
              模块
              <Input
                placeholder="模块名称"
                value={filter.module ?? ""}
                onChange={(event) => update({ module: event.target.value })}
              />
            </label>
            <label className="flex flex-col gap-2 text-sm">
              关联任务
              <Input
                placeholder="任务 ID"
                value={filter.runId ?? ""}
                onChange={(event) => update({ runId: event.target.value })}
              />
            </label>
          </div>
        </SettingsFoldout>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        已读取 {allLogs.length} 条，匹配 {logs.length} 条。仅筛选当前已读取记录，最多 1,000 条。
      </p>
      {!report ? (
        <p role="status" className="py-6 text-sm text-muted-foreground">
          检查完成后显示日志。
        </p>
      ) : !logs.length ? (
        <div className="flex flex-col items-start gap-3 py-6">
          <p className="text-sm">
            {unavailable
              ? "日志未读取成功"
              : !allLogs.length
                ? "暂未记录运行日志"
                : filter.level === "problems" &&
                    !filter.query &&
                    !filter.module &&
                    !filter.runId &&
                    !filter.from
                  ? "已读取记录中没有错误或警告"
                  : "没有匹配的日志"}
          </p>
          <p className="text-xs text-muted-foreground">
            {unavailable
              ? "请重新检查后台连接；空列表不能证明运行正常。"
              : "日志仅包含脱敏运行事件，不含消息、源码或凭据。"}
          </p>
          {allLogs.length ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setFilter({ level: "all" })
                setLimit(100)
              }}
            >
              查看全部日志
            </Button>
          ) : null}
        </div>
      ) : (
        <div className="mt-3 max-h-96 divide-y divide-border overflow-y-auto">
          {logs.slice(0, limit).map((log, index) => {
            const isError = /^(error|fatal|critical)$/i.test(log.level),
              isWarning = /^(warn|warning)$/i.test(log.level)
            return (
              <details key={`${log.time}:${index}`} className="group py-3">
                <summary className="flex cursor-pointer list-none flex-wrap items-center gap-3 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  <time className="w-20 shrink-0 text-xs text-muted-foreground tabular-nums">
                    {log.time ? new Date(log.time).toLocaleTimeString() : "时间未知"}
                  </time>
                  <SettingsStatus tone={isError ? "error" : isWarning ? "warning" : "neutral"}>
                    {isError
                      ? "错误"
                      : isWarning
                        ? "警告"
                        : log.level === "info"
                          ? "信息"
                          : log.level === "debug"
                            ? "调试"
                            : log.level}
                  </SettingsStatus>
                  <span className="min-w-0 flex-1 text-sm break-all">{log.event}</span>
                  <span className="text-xs text-muted-foreground">{log.module}</span>
                </summary>
                <div className="mt-3 flex flex-col gap-3 pl-2">
                  <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-xs">
                    {Object.entries(log).map(([key, value]) => (
                      <div key={key} className="contents">
                        <dt className="text-muted-foreground">
                          {(
                            {
                              time: "时间",
                              level: "级别",
                              module: "模块",
                              event: "事件",
                              runId: "任务",
                              sessionId: "对话",
                              traceId: "追踪标识",
                              status: "状态",
                              durationMs: "耗时（毫秒）",
                              requestId: "请求标识",
                              toolName: "工具",
                              method: "HTTP 方法",
                            } as Record<string, string>
                          )[key] ?? key}
                        </dt>
                        <dd className="break-all">
                          {key === "time" && value
                            ? new Date(Number(value)).toLocaleString()
                            : String(value)}
                        </dd>
                      </div>
                    ))}
                  </dl>
                  <div className="flex gap-3">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => onCopy(JSON.stringify(log, null, 2))}
                    >
                      复制记录
                    </Button>
                    {log.sessionId ? (
                      <Link
                        to="/conversation/$sessionId"
                        params={{ sessionId: log.sessionId }}
                        className="self-center text-xs underline underline-offset-4"
                      >
                        打开关联对话
                      </Link>
                    ) : null}
                  </div>
                </div>
              </details>
            )
          })}
          {logs.length > limit ? (
            <Button size="sm" variant="ghost" onClick={() => setLimit((current) => current + 100)}>
              再显示 100 条
            </Button>
          ) : null}
        </div>
      )}
    </SettingsGroup>
  )
}

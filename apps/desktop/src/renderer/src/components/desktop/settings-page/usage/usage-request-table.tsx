import { useState } from "react"
import { ChevronLeft, ChevronRight } from "lucide-react"
import { Button } from "@renderer/components/ui/button"
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  CardFooter,
} from "@renderer/components/motion/card"
import { UsageHelp } from "./usage-ui"
import { formatCount, type UsageRequest } from "./usage-analytics"

const pageSize = 10
const number = (value: number | null) => (value === null ? "—" : formatCount(value))

export function UsageRequestTable({ rows }: { rows: readonly UsageRequest[] }) {
  const [page, setPage] = useState(0)
  const pages = Math.max(1, Math.ceil(rows.length / pageSize))
  const current = Math.min(page, pages - 1)
  const start = current * pageSize
  return (
    <Card
      id="usage-details"
      role="region"
      aria-labelledby="usage-details-heading"
      size="compact"
      className="min-w-0 gap-3 border-border/70"
    >
      <CardHeader className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-1">
          <CardTitle as="h2" id="usage-details-heading">
            请求明细
          </CardTitle>
          <UsageHelp label="请求明细说明">
            <p>每页显示十条，导出包含全部筛选结果。未知字段显示“—”；任务 ID 悬停可看完整值。</p>
          </UsageHelp>
        </div>
        <span className="text-xs text-muted-foreground tabular-nums">
          {formatCount(rows.length)} 条记录
        </span>
      </CardHeader>
      {!rows.length ? (
        <CardContent className="py-6 text-sm text-muted-foreground">
          当前范围没有请求记录。试试调整时间或筛选条件。
        </CardContent>
      ) : (
        <>
          <CardContent
            className="overflow-x-auto rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            role="region"
            aria-label="请求明细表格，可横向滚动"
            tabIndex={0}
          >
            <table className="w-full min-w-[620px] text-left text-xs">
              <thead className="text-muted-foreground">
                <tr>
                  <th className="py-3 pr-4 font-normal">时间 / 任务</th>
                  <th className="px-2 py-3 font-normal">模型 / 供应商</th>
                  {["输入", "输出", "缓存读 / 写", "用量记录"].map((name) => (
                    <th key={name} className="px-2 py-3 text-right font-normal last:pr-0">
                      {name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.slice(start, start + pageSize).map((row) => (
                  <tr key={row.id} className="border-t border-border/60 tabular-nums">
                    <td className="py-3 pr-4 whitespace-nowrap">
                      <time
                        dateTime={new Date(row.time).toISOString()}
                        title={new Date(row.time).toLocaleString()}
                      >
                        {new Date(row.time).toLocaleString("zh-CN", {
                          month: "2-digit",
                          day: "2-digit",
                          hour: "2-digit",
                          minute: "2-digit",
                          second: "2-digit",
                          hour12: false,
                        })}
                      </time>
                      <p className="mt-1 text-muted-foreground" title={row.runId}>
                        任务 <span className="font-mono">{row.runId.slice(0, 8)}</span>
                      </p>
                    </td>
                    <td className="max-w-48 px-2 py-3">
                      <p className="truncate" title={row.model}>
                        {row.model === "unknown" ? "未知模型" : row.model}
                      </p>
                      <p className="mt-1 truncate text-muted-foreground" title={row.provider}>
                        {row.provider === "unknown" ? "未知供应商" : row.provider}
                      </p>
                    </td>
                    <td className="px-2 py-3 text-right">{number(row.inputTokens)}</td>
                    <td className="px-2 py-3 text-right">{number(row.outputTokens)}</td>
                    <td className="px-2 py-3 text-right whitespace-nowrap text-muted-foreground">
                      {number(row.cacheReadTokens)} / {number(row.cacheCreationTokens)}
                    </td>
                    <td className="py-3 pl-2 text-right whitespace-nowrap text-muted-foreground">
                      {row.status === "unfinished"
                        ? "等待回报"
                        : { complete: "已知", partial: "部分", unknown: "未知" }[row.completeness]}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
          <CardFooter className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <p className="tabular-nums">
              {formatCount(start + 1)}–{formatCount(Math.min(start + pageSize, rows.length))} /{" "}
              {formatCount(rows.length)} 条
            </p>
            {pages > 1 && (
              <div className="flex items-center gap-2">
                <Button
                  size="icon-sm"
                  shape="circle"
                  variant="ghost"
                  aria-label="上一页请求"
                  disabled={current === 0}
                  onClick={() => setPage(current - 1)}
                >
                  <ChevronLeft className="size-4" strokeWidth={1.75} />
                </Button>
                <span className="tabular-nums">
                  {current + 1} / {pages}
                </span>
                <Button
                  size="icon-sm"
                  shape="circle"
                  variant="ghost"
                  aria-label="下一页请求"
                  disabled={current === pages - 1}
                  onClick={() => setPage(current + 1)}
                >
                  <ChevronRight className="size-4" strokeWidth={1.75} />
                </Button>
              </div>
            )}
          </CardFooter>
        </>
      )}
    </Card>
  )
}

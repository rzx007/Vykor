import { CheckCircle2, ChevronDown, Circle } from "lucide-react"
import { Badge } from "@renderer/components/ui/badge"
import type { StorageReport } from "@shared/maintenance-settings-types"
import { formatBytes } from "./attachment-storage-format"

const colors = [
  "fill-chart-1",
  "fill-chart-2",
  "fill-chart-3",
  "fill-chart-4",
  "fill-chart-5",
  "fill-muted-foreground",
  "fill-foreground",
]

export function StorageSpaceOverview({ report }: { report: StorageReport }) {
  const partial = report.categories.some((category) => category.errors.length > 0)
  let offset = 0
  const segments = report.categories.map((category, index) => {
    const width =
      report.totalBytes > 0
        ? Math.max(0, Math.min(100, (category.bytes / report.totalBytes) * 100))
        : 0
    const segment = { ...category, width, start: offset, color: colors[index % colors.length] }
    offset += width
    return segment
  })
  return (
    <div className="flex flex-col gap-5">
      <dl className="flex flex-wrap gap-x-10 gap-y-3">
        <div>
          <dt className="text-xs text-muted-foreground">{partial ? "已知占用" : "应用占用"}</dt>
          <dd className="mt-1 text-xl font-semibold tabular-nums">
            {formatBytes(report.totalBytes)}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">磁盘可用</dt>
          <dd className="mt-1 text-xl font-semibold tabular-nums">
            {report.availableBytes === null ? "未知" : formatBytes(report.availableBytes)}
          </dd>
        </div>
        <div className="flex items-center">
          <Badge variant={partial || !report.writable ? "outline" : "secondary"}>
            {partial ? "部分统计" : report.writable ? "目录可写" : "目录不可写"}
          </Badge>
        </div>
      </dl>
      <svg
        viewBox="0 0 100 6"
        preserveAspectRatio="none"
        className="h-3 w-full overflow-hidden rounded-full"
        role="img"
        aria-label={`应用数据占用构成：${segments.map((item) => `${item.name} ${formatBytes(item.bytes)}`).join("，")}`}
      >
        <rect width="100" height="6" className="fill-muted" />
        {segments
          .filter((item) => item.width > 0)
          .map((item) => (
            <rect
              key={item.id}
              x={item.start}
              width={item.width}
              height="6"
              className={item.color}
            />
          ))}
      </svg>
      {report.totalBytes === 0 ? (
        <p className="text-xs text-muted-foreground">未扫描到可统计的占用。</p>
      ) : null}
      <div className="divide-y">
        {segments.map((item) => (
          <details key={item.id} className="group py-3">
            <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <svg viewBox="0 0 8 8" className="size-2 shrink-0" aria-hidden="true">
                <circle cx="4" cy="4" r="4" className={item.color} />
              </svg>
              <span className="min-w-0 flex-1 text-sm">{item.name}</span>
              {item.errors.length ? (
                <Badge variant="outline">{item.errors.length} 项异常</Badge>
              ) : null}
              <span className="text-xs text-muted-foreground tabular-nums">
                {item.files} 个文件
              </span>
              <span className="w-20 text-right text-sm tabular-nums">
                {formatBytes(item.bytes)}
              </span>
              <span className="w-12 text-right text-xs text-muted-foreground tabular-nums">
                {item.width.toFixed(1)}%
              </span>
              <ChevronDown
                className="size-3 shrink-0 text-muted-foreground transition-transform group-open:rotate-180 motion-reduce:transition-none"
                aria-hidden="true"
              />
            </summary>
            <div className="mt-3 flex flex-col gap-2 pl-5 text-xs text-muted-foreground">
              {item.paths.map((path) => (
                <p key={path} className="break-all">
                  {path}
                </p>
              ))}
              {item.errors.map((error) => (
                <p key={error} className="break-all text-destructive">
                  {error}
                </p>
              ))}
            </div>
          </details>
        ))}
      </div>
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer">数据目录与统计范围</summary>
        <div className="mt-2 flex flex-col gap-2">
          <p className="break-all">{report.dataDirectory}</p>
          <p>
            扫描于 {new Date(report.scannedAt).toLocaleString()}。仅统计应用目录，共享文件只计一次。
          </p>
        </div>
      </details>
    </div>
  )
}

export function StorageRestoreSteps({
  source,
  target,
  restored,
}: {
  source: string
  target: string
  restored: string
}) {
  const steps = [
    { label: "备份已校验", ready: Boolean(source), pending: "选择并校验备份" },
    { label: "目标已选择", ready: Boolean(target), pending: "选择空目录" },
    { label: "恢复数据就绪", ready: Boolean(restored), pending: "恢复到新目录" },
  ]
  return (
    <ol aria-label="恢复步骤" className="grid gap-3 sm:grid-cols-3">
      {steps.map((step) => (
        <li key={step.label} className="flex items-center gap-2 text-sm">
          {step.ready ? (
            <CheckCircle2 className="size-4 shrink-0 text-primary" aria-hidden="true" />
          ) : (
            <Circle className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          )}
          <span>{step.ready ? step.label : step.pending}</span>
        </li>
      ))}
    </ol>
  )
}

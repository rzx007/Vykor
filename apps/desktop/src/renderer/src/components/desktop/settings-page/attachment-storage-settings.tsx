import {
  AlertCircle,
  CheckCircle2,
  Database,
  HardDrive,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Trash2,
  TriangleAlert,
} from "lucide-react"
import { useEffect, useRef, useState } from "react"

import type {
  AttachmentStorageGcResult,
  AttachmentStorageIssue,
  AttachmentStorageRepairResult,
  AttachmentStorageReport,
} from "@vykor/client"
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@renderer/components/ui/alert"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@renderer/components/ui/alert-dialog"
import { Badge } from "@renderer/components/ui/badge"
import { Button } from "@renderer/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@renderer/components/ui/card"
import { Separator } from "@renderer/components/ui/separator"
import { Skeleton } from "@renderer/components/ui/skeleton"
import {
  canCollectStorage,
  canRepairStorage,
  formatBytes,
  groupStorageIssues,
  storageComposition,
  totalAssets,
  type GroupedStorageIssue,
} from "./attachment-storage-format"

type Operation = "idle" | "scanning" | "repairing" | "collecting"

type Feedback = {
  tone: "default" | "destructive"
  title: string
  description: string
}

const ISSUE_COPY: Record<AttachmentStorageIssue["code"], { title: string; description: string }> = {
  missing_blob: {
    title: "附件文件缺失",
    description: "附件记录仍然存在，但本地文件已经找不到。重新扫描后仍存在时需要检查数据来源。",
  },
  size_mismatch: {
    title: "附件文件大小异常",
    description: "本地文件大小与保存记录不一致，安全修复不会自动删除这类数据。",
  },
  orphan_blob: {
    title: "发现孤立文件",
    description: "这些文件没有任何附件记录引用，可以通过安全修复移除。",
  },
  stale_lease: {
    title: "发现过期占用",
    description: "有任务留下了已经过期的占用标记，可以通过安全修复清除。",
  },
  deleted_asset_retained: {
    title: "已删除附件等待清理",
    description: "这些数据仍在保留期内或等待回收，清理时会再次检查是否可以删除。",
  },
}

export function AttachmentStorageSettings(): React.JSX.Element {
  const mounted = useRef(true)
  const [report, setReport] = useState<AttachmentStorageReport | null>(null)
  const [operation, setOperation] = useState<Operation>("scanning")
  const [initialError, setInitialError] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const [unsupported, setUnsupported] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)

  useEffect(() => {
    mounted.current = true
    void loadInitialReport()
    return () => {
      mounted.current = false
    }
  }, [])

  const api = attachmentDiagnosticsApi()
  const busy = operation !== "idle"

  async function loadInitialReport(): Promise<void> {
    const initialApi = attachmentDiagnosticsApi()
    if (!initialApi) {
      if (mounted.current) {
        setUnsupported(true)
        setOperation("idle")
      }
      return
    }

    setOperation("scanning")
    setInitialError(null)
    try {
      const nextReport = await initialApi.scanStorage()
      if (mounted.current) setReport(nextReport)
    } catch (error) {
      if (mounted.current) setInitialError(errorMessage(error))
    } finally {
      if (mounted.current) setOperation("idle")
    }
  }

  async function refresh(): Promise<void> {
    if (!api || busy) return
    setOperation("scanning")
    setFeedback(null)
    try {
      const nextReport = await api.scanStorage()
      if (!mounted.current) return
      setReport(nextReport)
      setInitialError(null)
    } catch (error) {
      if (!mounted.current) return
      if (report) {
        setFeedback({
          tone: "destructive",
          title: "重新扫描失败",
          description: `${errorMessage(error)} 当前页面保留的是上一次扫描结果。`,
        })
      } else {
        setInitialError(errorMessage(error))
      }
    } finally {
      if (mounted.current) setOperation("idle")
    }
  }

  async function repair(): Promise<void> {
    if (!api || !report || busy || !canRepairStorage(report)) return
    setOperation("repairing")
    setFeedback(null)
    let result: AttachmentStorageRepairResult
    try {
      result = await api.repairStorage()
    } catch (error) {
      if (mounted.current) {
        setFeedback({
          tone: "destructive",
          title: "安全修复失败",
          description: errorMessage(error),
        })
        setOperation("idle")
      }
      return
    }

    try {
      const nextReport = await api.scanStorage()
      if (!mounted.current) return
      setReport(nextReport)
      setFeedback(repairFeedback(result))
    } catch (error) {
      if (mounted.current) {
        setFeedback({
          tone: "destructive",
          title: "安全修复完成，状态刷新失败",
          description: `${repairFeedback(result).description} ${errorMessage(error)} 当前页面保留的是上一次扫描结果。`,
        })
      }
    } finally {
      if (mounted.current) setOperation("idle")
    }
  }

  async function collect(): Promise<void> {
    if (!api || !report || busy || !canCollectStorage(report)) return
    setConfirmOpen(false)
    setOperation("collecting")
    setFeedback(null)
    let result: AttachmentStorageGcResult
    try {
      result = await api.gcStorage()
    } catch (error) {
      if (mounted.current) {
        setFeedback({
          tone: "destructive",
          title: "附件清理失败",
          description: `${errorMessage(error)} 请重新扫描后再试。`,
        })
        setOperation("idle")
      }
      return
    }

    try {
      const nextReport = await api.scanStorage()
      if (!mounted.current) return
      setReport(nextReport)
      setFeedback(collectionFeedback(result))
    } catch (error) {
      if (mounted.current) {
        setFeedback({
          tone: "destructive",
          title: "附件清理完成，状态刷新失败",
          description: `${collectionFeedback(result).description} ${errorMessage(error)} 当前页面保留的是上一次扫描结果。`,
        })
      }
    } finally {
      if (mounted.current) setOperation("idle")
    }
  }

  if (unsupported) {
    return (
      <Alert>
        <HardDrive />
        <AlertTitle>当前环境不支持附件存储诊断</AlertTitle>
        <AlertDescription>请在 Vykor 桌面应用中打开这一页。</AlertDescription>
      </Alert>
    )
  }

  if (!report && operation === "scanning") return <StorageSettingsSkeleton />

  if (!report && initialError) {
    return (
      <Alert variant="destructive">
        <AlertCircle />
        <AlertTitle>无法读取附件存储状态</AlertTitle>
        <AlertDescription>{initialError}</AlertDescription>
        <AlertAction>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void loadInitialReport()}
          >
            重试
          </Button>
        </AlertAction>
      </Alert>
    )
  }

  if (!report) return <StorageSettingsSkeleton />

  const groupedIssues = groupStorageIssues(report.issues)
  const repairAvailable = canRepairStorage(report)
  const collectionAvailable = canCollectStorage(report)

  return (
    <div className="flex flex-col gap-10">
      {feedback ? (
        <Alert variant={feedback.tone === "destructive" ? "destructive" : "default"}>
          {feedback.tone === "destructive" ? <AlertCircle /> : <CheckCircle2 />}
          <AlertTitle>{feedback.title}</AlertTitle>
          <AlertDescription>{feedback.description}</AlertDescription>
        </Alert>
      ) : null}

      <StorageOverview report={report} operation={operation} onRefresh={() => void refresh()} />
      <StorageHealth issues={groupedIssues} />

      <section className="flex flex-col gap-4" aria-labelledby="attachment-storage-maintenance">
        <div className="flex items-end justify-between gap-4">
          <h2 id="attachment-storage-maintenance" className="font-heading text-lg font-semibold">
            维护
          </h2>
          {report.latestGcAudit ? (
            <p className="text-xs text-muted-foreground">
              上次清理：{formatAuditTime(report.latestGcAudit.createdAt)}
            </p>
          ) : null}
        </div>
        <Card className="py-0">
          <CardContent className="px-5">
            <MaintenanceRow
              icon={<ShieldCheck />}
              title="安全修复"
              description="清除过期占用标记，并移除没有任何附件记录引用的孤立文件。不会删除仍被对话引用的附件。"
              action={
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy || !repairAvailable}
                  onClick={() => void repair()}
                >
                  {operation === "repairing" ? (
                    <RefreshCw className="animate-spin" />
                  ) : (
                    <Sparkles />
                  )}
                  {repairAvailable ? "安全修复" : "无需修复"}
                </Button>
              }
            />
            <Separator />
            <MaintenanceRow
              icon={<Trash2 />}
              title="清理无用附件"
              description="只处理已经标记删除、超过保留期、没有引用且没有任务正在使用的数据。执行前会再次确认。"
              action={
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  disabled={busy || !collectionAvailable}
                  onClick={() => setConfirmOpen(true)}
                >
                  <Trash2 />
                  {collectionAvailable
                    ? `清理 ${formatBytes(report.summary.reclaimableBytes)}`
                    : "暂无可清理内容"}
                </Button>
              }
            />
          </CardContent>
        </Card>
      </section>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia>
              <Trash2 />
            </AlertDialogMedia>
            <AlertDialogTitle>确认清理无用附件？</AlertDialogTitle>
            <AlertDialogDescription>
              只会删除已经过保留期、没有对话引用、没有活跃占用且不是共享文件的数据。删除后无法从本地附件存储恢复；
              {formatBytes(report.summary.reclaimableBytes)}{" "}
              是当前扫描的估算值，实际结果以执行时为准。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={operation === "collecting"}>取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={operation === "collecting"}
              onClick={() => void collect()}
            >
              确认清理
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function StorageOverview({
  report,
  operation,
  onRefresh,
}: {
  report: AttachmentStorageReport
  operation: Operation
  onRefresh: () => void
}): React.JSX.Element {
  const assets = report.summary.assets
  const composition = storageComposition(
    report.summary.physicalBytes,
    report.summary.reclaimableBytes
  )
  const retainedPercent = Math.round(composition.retainedPercent)
  const reclaimablePercent = Math.round(composition.reclaimablePercent)
  const compositionLabel = `实际占用由当前保留 ${retainedPercent}% 和可清理 ${reclaimablePercent}% 组成；去重节省不计入实际占用`

  return (
    <section className="flex flex-col gap-4" aria-labelledby="attachment-storage-overview">
      <div className="flex items-center justify-between gap-4">
        <h2 id="attachment-storage-overview" className="font-heading text-lg font-semibold">
          空间概览
        </h2>
        <StorageStatus issues={report.issues} />
      </div>
      <Card>
        <CardHeader>
          <CardTitle>本地附件</CardTitle>
          <CardDescription>统计当前设备上的对话附件，不包含云端账号空间。</CardDescription>
          <CardAction className="flex flex-col items-end gap-3">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={operation !== "idle"}
              onClick={onRefresh}
            >
              <RefreshCw className={operation === "scanning" ? "animate-spin" : undefined} />
              {operation === "scanning" ? "正在扫描" : "重新扫描"}
            </Button>
            <div className="text-right">
              <p className="font-heading text-2xl font-semibold tracking-tight tabular-nums">
                {formatBytes(report.summary.physicalBytes)}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">实际占用</p>
            </div>
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-5 px-0">
          <div className="flex flex-col gap-4 px-5">
            <svg
              viewBox="0 0 100 4"
              preserveAspectRatio="none"
              className="h-2.5 w-full overflow-hidden rounded-full"
              role="img"
              aria-label={compositionLabel}
              focusable="false"
            >
              <rect width="100" height="4" className="fill-muted" />
              {composition.retainedPercent > 0 ? (
                <rect width={composition.retainedPercent} height="4" className="fill-chart-2" />
              ) : null}
              {composition.reclaimablePercent > 0 ? (
                <rect
                  x={composition.retainedPercent}
                  width={composition.reclaimablePercent}
                  height="4"
                  className="fill-chart-4"
                />
              ) : null}
            </svg>

            <div className="grid gap-4 sm:grid-cols-3">
              <StorageCompositionStat
                markerClassName="bg-chart-2"
                label="当前保留"
                value={formatBytes(composition.retainedBytes)}
                detail="实际保存在本机"
              />
              <StorageCompositionStat
                markerClassName="bg-muted-foreground/45"
                label="去重节省"
                value={formatBytes(report.summary.deduplicatedBytes)}
                detail="重复文件只保存一份"
              />
              <StorageCompositionStat
                markerClassName="bg-chart-4"
                label="可清理"
                value={formatBytes(composition.reclaimableBytes)}
                detail="满足当前清理条件"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-px border-y bg-border/60 sm:grid-cols-3 lg:grid-cols-5">
            <StorageStat
              label="附件总数"
              value={String(totalAssets(assets))}
              detail={`${assets.ready} 个可用`}
              icon={<Database />}
            />
            <StorageStat label="唯一文件" value={String(report.summary.uniqueBlobs)} />
            <StorageStat label="正在使用" value={String(report.summary.activeLeases)} />
            <StorageStat label="正在导入" value={String(assets.importing)} />
            <StorageStat label="处理失败" value={String(assets.failed)} />
          </div>
        </CardContent>
        <CardFooter className="justify-between gap-4 text-xs text-muted-foreground">
          <span>附件逻辑大小 {formatBytes(report.summary.logicalBytes)}</span>
          <span>{report.summary.expiredLeases} 个过期占用</span>
        </CardFooter>
      </Card>
    </section>
  )
}

function StorageCompositionStat({
  markerClassName,
  label,
  value,
  detail,
}: {
  markerClassName: string
  label: string
  value: string
  detail: string
}): React.JSX.Element {
  return (
    <div className="flex min-w-0 items-start gap-2.5">
      <span
        className={`mt-1.5 size-2 shrink-0 rounded-full ${markerClassName}`}
        aria-hidden="true"
      />
      <div className="min-w-0">
        <p className="text-sm font-medium">
          {label} <span className="tabular-nums">{value}</span>
        </p>
        <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{detail}</p>
      </div>
    </div>
  )
}

function StorageStat({
  label,
  value,
  detail,
  icon,
}: {
  label: string
  value: string
  detail?: string
  icon?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="min-w-0 bg-card px-4 py-4">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {icon ? <span className="[&_svg]:size-3.5">{icon}</span> : null}
        <span>{label}</span>
      </div>
      <p className="mt-2 text-base font-semibold tracking-tight tabular-nums">{value}</p>
      {detail ? <p className="text-ui-caption mt-1 text-muted-foreground">{detail}</p> : null}
    </div>
  )
}

function StorageStatus({
  issues,
}: {
  issues: readonly AttachmentStorageIssue[]
}): React.JSX.Element {
  const hasError = issues.some((issue) => issue.severity === "error")
  if (hasError) return <Badge variant="destructive">需要检查</Badge>
  if (issues.length > 0) return <Badge variant="outline">可处理</Badge>
  return (
    <Badge variant="secondary">
      <CheckCircle2 data-icon="inline-start" />
      存储正常
    </Badge>
  )
}

function StorageHealth({ issues }: { issues: readonly GroupedStorageIssue[] }): React.JSX.Element {
  return (
    <section className="flex flex-col gap-4" aria-labelledby="attachment-storage-health">
      <h2 id="attachment-storage-health" className="font-heading text-lg font-semibold">
        健康检查
      </h2>
      <Card className="py-0">
        <CardContent className="px-5">
          {issues.length === 0 ? (
            <div className="flex min-h-20 items-center gap-3 py-4">
              <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
                <CheckCircle2 className="size-4" />
              </span>
              <div>
                <h3 className="text-sm font-medium">文件完整性正常</h3>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  没有发现缺失、大小异常或等待处理的附件数据。
                </p>
              </div>
            </div>
          ) : (
            issues.map((issue, index) => (
              <div key={issue.code}>
                {index > 0 ? <Separator /> : null}
                <StorageIssueRow issue={issue} />
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </section>
  )
}

function StorageIssueRow({ issue }: { issue: GroupedStorageIssue }): React.JSX.Element {
  const copy = ISSUE_COPY[issue.code]
  return (
    <div className="flex min-h-20 items-center gap-3 py-4">
      <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
        {issue.severity === "error" ? (
          <AlertCircle className="size-4 text-destructive" />
        ) : (
          <TriangleAlert className="size-4" />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <h3 className="text-sm font-medium">{copy.title}</h3>
        <p className="mt-1 max-w-3xl text-xs leading-5 text-muted-foreground">{copy.description}</p>
      </div>
      <Badge variant={issue.severity === "error" ? "destructive" : "outline"}>
        {issue.count} 项
      </Badge>
    </div>
  )
}

function MaintenanceRow({
  icon,
  title,
  description,
  action,
}: {
  icon: React.ReactNode
  title: string
  description: string
  action: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex min-h-24 items-center gap-4 py-4">
      <span className="hidden size-9 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground sm:grid [&_svg]:size-4">
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <h3 className="text-sm font-medium">{title}</h3>
        <p className="mt-1 max-w-3xl text-xs leading-5 text-muted-foreground">{description}</p>
      </div>
      <div className="shrink-0">{action}</div>
    </div>
  )
}

function StorageSettingsSkeleton(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-10" role="status" aria-label="正在扫描附件存储">
      <section className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <Skeleton className="h-6 w-24" />
          <Skeleton className="h-5 w-20 rounded-full" />
        </div>
        <Card>
          <CardHeader className="border-b">
            <Skeleton className="h-5 w-28" />
            <Skeleton className="h-4 w-64 max-w-full" />
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {Array.from({ length: 8 }, (_, index) => (
              <Skeleton key={index} className="h-16" />
            ))}
          </CardContent>
        </Card>
      </section>
      <Skeleton className="h-32 w-full rounded-xl" />
      <Skeleton className="h-44 w-full rounded-xl" />
    </div>
  )
}

function attachmentDiagnosticsApi():
  | Pick<Window["desktop"]["attachments"], "scanStorage" | "repairStorage" | "gcStorage">
  | undefined {
  const attachments = window.desktop?.attachments
  if (
    typeof attachments?.scanStorage !== "function" ||
    typeof attachments.repairStorage !== "function" ||
    typeof attachments.gcStorage !== "function"
  ) {
    return undefined
  }
  return attachments
}

function repairFeedback(result: AttachmentStorageRepairResult): Feedback {
  return {
    tone: "default",
    title: "安全修复完成",
    description: `已清除 ${result.expiredLeases} 个过期占用，删除 ${result.deletedOrphanBlobs} 个孤立文件，释放 ${formatBytes(result.releasedBytes)}。`,
  }
}

function collectionFeedback(result: AttachmentStorageGcResult): Feedback {
  const partial = result.errors.length > 0
  return {
    tone: partial ? "destructive" : "default",
    title: partial ? "附件清理部分完成" : "附件清理完成",
    description: `已扫描 ${result.scannedAssets} 个附件，已删除 ${result.deletedAssets} 个附件和 ${result.deletedBlobs} 个文件，释放 ${formatBytes(result.releasedBytes)}${partial ? `，另有 ${result.errors.length} 项删除失败。` : "。"}`,
  }
}

function formatAuditTime(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "未知"
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

import {
  AlertCircle,
  HardDrive,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Trash2,
} from "lucide-react"
import { useEffect, useRef, useState } from "react"

import type {
  AttachmentStorageGcResult,
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
import { Button } from "@renderer/components/ui/button"
import {
  Card,
  CardContent,
  CardHeader,
} from "@renderer/components/ui/card"
import { Separator } from "@renderer/components/ui/separator"
import { Skeleton } from "@renderer/components/ui/skeleton"
import { toast } from "@renderer/lib/toast"
import {
  canCollectStorage,
  canRepairStorage,
  formatBytes,
  groupStorageIssues,
} from "./attachment-storage-format"
import { MaintenanceRow, StorageHealth, StorageOverview, type Operation } from "./attachment-storage-view"

type Feedback = {
  tone: "default" | "destructive"
  title: string
  description: string
}

export function AttachmentStorageSettings(): React.JSX.Element {
  const mounted = useRef(true)
  const [report, setReport] = useState<AttachmentStorageReport | null>(null)
  const [operation, setOperation] = useState<Operation>("scanning")
  const [initialError, setInitialError] = useState<string | null>(null)
  const [unsupported, setUnsupported] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)

  useEffect(() => {
    mounted.current = true
    void loadInitialReport()
    return () => {
      mounted.current = false
    }
  }, [])

  function notifyFeedback(feedback: Feedback): void {
    if (feedback.tone === "destructive") toast.error(feedback.title, feedback.description)
    else toast.success(feedback.title, feedback.description)
  }

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
    try {
      const nextReport = await api.scanStorage()
      if (!mounted.current) return
      setReport(nextReport)
      setInitialError(null)
    } catch (error) {
      if (!mounted.current) return
      if (report) {
        notifyFeedback({
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
    let result: AttachmentStorageRepairResult
    try {
      result = await api.repairStorage()
    } catch (error) {
      if (mounted.current) {
        notifyFeedback({
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
      notifyFeedback(repairFeedback(result))
    } catch (error) {
      if (mounted.current) {
        notifyFeedback({
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
    let result: AttachmentStorageGcResult
    try {
      result = await api.gcStorage()
    } catch (error) {
      if (mounted.current) {
        notifyFeedback({
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
      notifyFeedback(collectionFeedback(result))
    } catch (error) {
      if (mounted.current) {
        notifyFeedback({
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

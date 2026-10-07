import { useEffect, useRef, useState } from "react"
import { Link } from "@tanstack/react-router"
import { LoaderCircle } from "lucide-react"
import { Button } from "@renderer/components/ui/button"
import { Switch } from "@renderer/components/ui/switch"
import { Alert, AlertDescription } from "@renderer/components/ui/alert"
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogAction,
  AlertDialogCancel,
} from "@renderer/components/ui/alert-dialog"
import type { DiagnosticCheck, DiagnosticReport } from "@shared/maintenance-settings-types"
import { toast } from "@renderer/lib/toast"
import { maintenanceApi } from "./usage-settings"
import { SettingsGroup, SettingsRow, SettingsFoldout, SettingsSelect } from "./settings-group"
import { SettingsStatus, type SettingsStatusTone } from "./settings-status"
import { diagnosisSummary } from "./diagnostics-presentation"
import { DiagnosticsLogViewer } from "./diagnostics-log-viewer"
import { errorMessage } from "./settings-error-message"

const checkStates: Record<DiagnosticCheck["status"], { tone: SettingsStatusTone; label: string }> =
  {
    success: { tone: "success", label: "通过" },
    failed: { tone: "error", label: "需要处理" },
    warning: { tone: "warning", label: "建议检查" },
    timeout: { tone: "warning", label: "检查超时" },
    cancelled: { tone: "neutral", label: "已取消" },
    unsupported: { tone: "neutral", label: "不支持" },
  }
export function DiagnosticsSettings() {
  const [report, setReport] = useState<DiagnosticReport | null>(null)
  const [checking, setChecking] = useState(false)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState("")
  const [restartOpen, setRestartOpen] = useState(false)
  const [detailsExpiry, setDetailsExpiry] = useState<number | null>(null)
  const [detailsReady, setDetailsReady] = useState(false)
  const [duration, setDuration] = useState("15")
  const [now, setNow] = useState(Date.now)
  const mounted = useRef(false),
    requestId = useRef<string | null>(null),
    locked = useRef(false)
  const busy = checking || working
  async function act(work: () => Promise<unknown>, message: string) {
    if (locked.current || checking) return
    locked.current = true
    setWorking(true)
    setError("")
    try {
      const result = await work()
      if (!mounted.current) return
      if (typeof result === "string") toast.success("导出完成", result)
      else if (message) {
        if (result === null) toast.info(message)
        else toast.success(message)
      }
    } catch (failure) {
      if (mounted.current) setError(errorMessage(failure))
    } finally {
      locked.current = false
      if (mounted.current) setWorking(false)
    }
  }
  async function diagnose(notify = true): Promise<DiagnosticReport | null> {
    if (locked.current) return null
    const id = crypto.randomUUID()
    requestId.current = id
    setChecking(true)
    setError("")
    try {
      const next = await maintenanceApi().diagnose({ requestId: id })
      if (!mounted.current || requestId.current !== id) return null
      setReport(next)
      if (notify) {
        const summary = diagnosisSummary(next.checks)
        if (summary.tone === "success") toast.success(summary.title)
        else toast.info(summary.title)
      }
      return next
    } catch (failure) {
      if (mounted.current && requestId.current === id) setError(errorMessage(failure))
      return null
    } finally {
      if (mounted.current && requestId.current === id) setChecking(false)
    }
  }
  async function readDetails() {
    try {
      const value = await maintenanceApi().diagnosticDetails()
      if (mounted.current) {
        setDetailsExpiry(value.expiresAt)
        setDetailsReady(true)
        setNow(Date.now())
      }
    } catch {
      if (mounted.current) setDetailsReady(false)
    }
  }
  useEffect(() => {
    mounted.current = true
    void diagnose(false)
    void readDetails()
    const timer = setInterval(() => void readDetails(), 15_000)
    return () => {
      mounted.current = false
      clearInterval(timer)
      const owned = requestId.current
      requestId.current = null
      if (owned)
        void Promise.resolve()
          .then(() => maintenanceApi().cancelDiagnosis({ requestId: owned }))
          .catch(() => {})
    }
  }, [])
  const summary = diagnosisSummary(report?.checks ?? [])
  const issues = (report?.checks ?? [])
    .filter((item) => ["failed", "warning", "timeout"].includes(item.status))
    .sort((a, b) => Number(b.status === "failed") - Number(a.status === "failed"))
  const passed = (report?.checks ?? []).filter((item) => item.status === "success")
  const unconfirmed = (report?.checks ?? []).filter((item) =>
    ["cancelled", "unsupported"].includes(item.status)
  )
  const detailed = detailsExpiry !== null && detailsExpiry > now
  function checkRow(check: DiagnosticCheck, actionable = false) {
    const section = check.id.startsWith("environment")
      ? "runtime"
      : check.id === "auth"
        ? "providers"
        : check.id === "storage"
          ? "storage"
          : null
    return (
      <div key={check.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="text-sm font-medium">{check.name}</h3>
            <SettingsStatus tone={checkStates[check.status].tone}>
              {checkStates[check.status].label}
            </SettingsStatus>
          </div>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">{check.detail}</p>
        </div>
        {actionable && section ? (
          <Link
            to="/settings/$section"
            params={{ section }}
            className="self-center text-xs underline underline-offset-4"
          >
            打开相关设置
          </Link>
        ) : null}
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-8" aria-busy={busy}>
      <SettingsGroup
        title="检查概览"
        id="diagnostics-status"
        action={
          <div className="flex flex-wrap gap-2">
            {checking ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  const id = requestId.current
                  if (id)
                    void maintenanceApi()
                      .cancelDiagnosis({ requestId: id })
                      .catch((failure) => setError(errorMessage(failure)))
                }}
              >
                取消检查
              </Button>
            ) : (
              <Button size="sm" disabled={busy} onClick={() => void diagnose()}>
                重新检查
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              disabled={busy || !report}
              onClick={() =>
                void act(() => maintenanceApi().exportDiagnostics({}, "diagnostics"), "导出已取消")
              }
            >
              导出诊断包
            </Button>
          </div>
        }
      >
        {checking ? (
          <div role="status" className="flex items-center gap-2 text-sm font-medium">
            <LoaderCircle
              aria-hidden="true"
              className="size-4 animate-spin motion-reduce:animate-none"
            />
            正在检查{report ? "，下方保留上次结果" : ""}
          </div>
        ) : (
          <SettingsStatus tone={report ? summary.tone : "neutral"}>
            {report ? summary.title : "尚未取得检查结果"}
          </SettingsStatus>
        )}
        <p className="mt-2 text-xs text-muted-foreground">
          {report
            ? `通过 ${summary.passed} · 需处理 ${summary.failed} · 提示 ${summary.warnings} · 未完成 ${summary.incomplete} · ${new Date(report.checkedAt).toLocaleString()}`
            : "只读检查，不调用模型或发送消息。整轮检查最长 15 秒。"}
        </p>
        {error ? (
          <Alert variant="destructive" className="mt-4">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        {issues.length ? (
          <div className="mt-4 divide-y divide-border">
            {issues.map((item) => checkRow(item, true))}
          </div>
        ) : null}
        {report && !checking && summary.incomplete ? (
          <p className="mt-3 text-xs text-muted-foreground">
            未完成的检查无法用于判断服务是否正常，可重新检查。
          </p>
        ) : null}
        {passed.length ? (
          <div className="mt-3">
            <SettingsFoldout title={`已通过检查（${passed.length}）`}>
              {passed.map((item) => checkRow(item))}
            </SettingsFoldout>
          </div>
        ) : null}
        {unconfirmed.length ? (
          <div className="mt-3">
            <SettingsFoldout title={`未确认的检查（${unconfirmed.length}）`}>
              {unconfirmed.map((item) => checkRow(item))}
            </SettingsFoldout>
          </div>
        ) : null}
      </SettingsGroup>
      <DiagnosticsLogViewer
        report={report}
        busy={busy}
        detailsExpiry={detailsExpiry}
        onExport={(filter) =>
          void act(() => maintenanceApi().exportDiagnostics(filter, "logs"), "导出已取消")
        }
        onCopy={(content) => void act(() => navigator.clipboard.writeText(content), "日志已复制")}
      />
      <SettingsFoldout title="高级排查" id="diagnostics-advanced">
        <SettingsGroup title="连接与后台服务">
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void act(() => maintenanceApi().reconnect(), "已重新连接后台服务")}
            >
              重新连接
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                void diagnose(false).then((next) => {
                  if (next && mounted.current) {
                    if (next.activeWork) setRestartOpen(true)
                    else setError("未取得活动任务清单，无法安全重启。请重新检查。")
                  }
                })
              }}
            >
              重启后台服务
            </Button>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            重启前检查活动任务与终端，不会续跑旧任务。
          </p>
        </SettingsGroup>
        <SettingsGroup title="临时详细日志" id="diagnostics-details" separated>
          <SettingsRow
            title="详细运行字段"
            description={
              !detailsReady
                ? "暂未读取到设置状态。"
                : detailed
                  ? `到期：${new Date(detailsExpiry!).toLocaleTimeString()}。不含消息或机密。`
                  : "已关闭。开启后显示请求标识、工具名和 HTTP 方法。"
            }
            control={
              <Switch
                aria-label="详细运行字段"
                checked={detailed}
                disabled={busy || !detailsReady}
                onCheckedChange={(enabled) =>
                  void act(
                    async () => {
                      const value = await maintenanceApi().updateDiagnosticDetails(
                        enabled ? Number(duration) : 0
                      )
                      setDetailsExpiry(value.expiresAt)
                      setNow(Date.now())
                    },
                    enabled ? "临时详细日志已开启" : "详细运行信息已关闭"
                  )
                }
              />
            }
          />
          {detailed ? (
            <SettingsRow
              title="有效时长"
              control={
                <SettingsSelect
                  label="详细日志时长"
                  value={duration}
                  options={[15, 30, 60].map((minutes) => ({
                    value: String(minutes),
                    label: `${minutes} 分钟`,
                  }))}
                  disabled={busy}
                  onChange={(minutes) =>
                    void act(async () => {
                      const value = await maintenanceApi().updateDiagnosticDetails(Number(minutes))
                      setDuration(minutes)
                      setDetailsExpiry(value.expiresAt)
                    }, "有效时长已更新")
                  }
                />
              }
            />
          ) : null}
        </SettingsGroup>
        {report ? (
          <SettingsGroup title="环境与读取详情">
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-xs">
              <dt>桌面版本</dt>
              <dd>{report.desktopVersion}</dd>
              <dt>系统</dt>
              <dd>
                {report.platform} / {report.architecture}
              </dd>
              <dt>连接地址</dt>
              <dd className="break-all">{report.target ?? "未连接"}</dd>
            </dl>
            {report.missing.length ? (
              <p className="mt-3 text-xs leading-5 text-muted-foreground">
                未读取的信息：{report.missing.join("、")}
              </p>
            ) : null}
            <p className="mt-3 text-xs text-muted-foreground">
              诊断包包含检查结果和脱敏运行日志，不含消息、源码、指令、凭据或绝对路径。
            </p>
          </SettingsGroup>
        ) : null}
      </SettingsFoldout>
      <AlertDialog open={restartOpen} onOpenChange={setRestartOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>重启后台服务？</AlertDialogTitle>
            <AlertDialogDescription>
              任务和终端须先结束。重启不会续跑旧任务或恢复终端。
            </AlertDialogDescription>
            {report?.activeWork ? (
              <div className="flex flex-col gap-2 text-xs text-muted-foreground">
                <p>
                  活动运行 {report.activeWork.runs.length}，后台任务{" "}
                  {report.activeWork.tasks.length}，终端 {report.activeWork.terminals.length}。
                </p>
                {[...report.activeWork.runs, ...report.activeWork.tasks].map((work) => (
                  <Link
                    key={work.id}
                    to="/conversation/$sessionId"
                    params={{ sessionId: work.sessionId }}
                    className="underline"
                  >
                    {work.id} · {work.status} · 打开对话
                  </Link>
                ))}
              </div>
            ) : null}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={
                busy ||
                !report?.activeWork ||
                Boolean(
                  report.activeWork.runs.length +
                  report.activeWork.tasks.length +
                  report.activeWork.terminals.length
                )
              }
              onClick={() =>
                void act(async () => {
                  await maintenanceApi().restart()
                  setRestartOpen(false)
                }, "后台服务已安全重启")
              }
            >
              确认重启
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

import { SettingsGroup } from "./settings-group"
import { useEffect, useState } from "react"
import { Link } from "@tanstack/react-router"
import { Button } from "@renderer/components/ui/button"
import { Input } from "@renderer/components/ui/input"
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
import type { DiagnosticFilter, DiagnosticReport } from "@shared/maintenance-settings-types"
import { maintenanceApi } from "./usage-settings"
import { errorMessage } from "./settings-error-message"

export function DiagnosticsSettings() {
  const [report, setReport] = useState<DiagnosticReport | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [feedback, setFeedback] = useState("")
  const [filter, setFilter] = useState<DiagnosticFilter>({})
  const [restartOpen, setRestartOpen] = useState(false)
  const [detailsExpiry, setDetailsExpiry] = useState<number | null>(null)
  async function act(work: () => Promise<unknown>, message: string) {
    setBusy(true)
    try {
      const result = await work()
      setFeedback(typeof result === "string" ? `已导出到 ${result}` : message)
      setError("")
    } catch (error) {
      setError(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }
  async function diagnose() {
    await act(async () => setReport(await maintenanceApi().diagnose()), "检查结束；各项状态如下")
  }
  useEffect(() => {
    void diagnose()
    const readDetails = () =>
      Promise.resolve()
        .then(() => maintenanceApi().diagnosticDetails())
        .then((value) => setDetailsExpiry(value.expiresAt))
        .catch(() => {})
    void readDetails()
    const timer = setInterval(() => {
      void readDetails()
    }, 15_000)
    return () => {
      clearInterval(timer)
      void Promise.resolve()
        .then(() => maintenanceApi().cancelDiagnosis())
        .catch(() => {})
    }
  }, [])
  const logs = (report?.logs ?? [])
    .filter(
      (row) =>
        (!filter.from || row.time >= filter.from) &&
        (!filter.level || row.level === filter.level) &&
        (!filter.module || row.module === filter.module) &&
        (!filter.runId || row.runId === filter.runId)
    )
    .map((log) => {
      if (detailsExpiry && detailsExpiry > Date.now()) return log
      const { requestId: _request, toolName: _tool, method: _method, ...basic } = log
      return basic
    })
  return (
    <div className="flex flex-col gap-8">
      <SettingsGroup title="服务检查" id="diagnostics-status">
        <p className="text-xs text-muted-foreground">
          只读检查，不调用模型或发送消息；单项最长 15 秒，可取消。
        </p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={busy} onClick={() => void diagnose()}>
            重新检查
          </Button>
          {busy ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void maintenanceApi().cancelDiagnosis()}
            >
              取消检查
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void act(() => maintenanceApi().reconnect(), "已重新连接后台服务")}
          >
            重新连接
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() =>
              void act(async () => {
                setReport(await maintenanceApi().diagnose())
                setRestartOpen(true)
              }, "重启前清单已刷新")
            }
          >
            重启后台服务
          </Button>
        </div>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {feedback ? (
          <p role="status" className="text-xs text-muted-foreground">
            {feedback}
          </p>
        ) : null}
        {!report ? (
          <p role="status" className="text-sm">
            {busy ? "正在检查…" : "尚无检查结果"}
          </p>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">
              桌面 {report.desktopVersion} · {report.platform} / {report.architecture} · 连接{" "}
              {report.target ?? "未连接"} · {new Date(report.checkedAt).toLocaleString()}
            </p>
            <div className="divide-y">
              {report.checks.map((check) => (
                <div key={check.id} className="py-3 text-sm">
                  <div className="flex justify-between">
                    <span>{check.name}</span>
                    <span
                      className={
                        check.status === "failed" ? "text-destructive" : "text-muted-foreground"
                      }
                    >
                      {
                        {
                          success: "成功",
                          warning: "警告",
                          failed: "失败",
                          unsupported: "不支持",
                          timeout: "超时",
                          cancelled: "已取消",
                        }[check.status]
                      }
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">{check.detail}</p>
                </div>
              ))}
            </div>
            {report.missing.length ? (
              <p className="text-xs text-muted-foreground">未取得：{report.missing.join("、")}</p>
            ) : null}
          </>
        )}
      </SettingsGroup>
      <SettingsGroup title="运行日志" id="diagnostics-logs">
        <div className="settings-filter-grid">
          <label className="flex min-w-0 flex-col gap-2 text-sm">
            时间
            <select
              className="h-8 w-full min-w-0 rounded-lg border border-input bg-background px-2 text-sm"
              onChange={(event) =>
                setFilter((previous) => ({
                  ...previous,
                  from: event.target.value
                    ? Date.now() - Number(event.target.value) * 86400000
                    : undefined,
                }))
              }
            >
              <option value="">全部已读取</option>
              <option value="1">最近 24 小时</option>
              <option value="7">最近 7 天</option>
            </select>
          </label>
          <label className="flex min-w-0 flex-col gap-2 text-sm">
            级别
            <select
              className="h-8 w-full min-w-0 rounded-lg border border-input bg-background px-2 text-sm"
              value={filter.level ?? ""}
              onChange={(event) =>
                setFilter((previous) => ({ ...previous, level: event.target.value }))
              }
            >
              <option value="">全部</option>
              {["debug", "info", "warn", "error"].map((level) => (
                <option key={level}>{level}</option>
              ))}
            </select>
          </label>
          <label className="flex min-w-0 flex-col gap-2 text-sm">
            模块
            <Input
              placeholder="模块名称"
              value={filter.module ?? ""}
              onChange={(event) =>
                setFilter((previous) => ({ ...previous, module: event.target.value }))
              }
            />
          </label>
          <label className="flex min-w-0 flex-col gap-2 text-sm">
            关联任务 ID
            <Input
              placeholder="输入任务 ID"
              value={filter.runId ?? ""}
              onChange={(event) =>
                setFilter((previous) => ({ ...previous, runId: event.target.value }))
              }
            />
          </label>
        </div>
        {!logs.length ? (
          <p className="text-sm text-muted-foreground">当前筛选暂无日志。</p>
        ) : (
          <div className="max-h-96 divide-y overflow-auto">
            {logs.map((log, index) => (
              <div
                key={`${log.time}:${index}`}
                className="flex items-start justify-between gap-3 py-2 text-xs"
              >
                <div>
                  {log.time ? new Date(log.time).toLocaleString() : "未记录时间"} · {log.level} ·{" "}
                  {log.event}
                  <p className="text-muted-foreground">
                    {log.runId ?? log.traceId ?? ""}
                    {log.sessionId ? (
                      <Link
                        className="ml-2 underline"
                        to="/conversation/$sessionId"
                        params={{ sessionId: log.sessionId }}
                      >
                        打开关联会话
                      </Link>
                    ) : null}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    void act(() => navigator.clipboard.writeText(JSON.stringify(log)), "日志已复制")
                  }
                >
                  复制
                </Button>
              </div>
            ))}
          </div>
        )}
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() =>
            void act(() => maintenanceApi().exportDiagnostics(filter, "logs"), "导出已取消")
          }
        >
          导出筛选结果
        </Button>
      </SettingsGroup>
      <SettingsGroup title="临时详细日志" id="diagnostics-details">
        <p className="text-xs text-muted-foreground">
          显示请求标识、工具名和 HTTP 方法，不含消息或机密；到期或重启后关闭。
          {detailsExpiry ? ` 到期 ${new Date(detailsExpiry).toLocaleString()}` : " 当前关闭。"}
        </p>
        <div className="flex flex-wrap gap-2">
          {[15, 30, 60].map((minutes) => (
            <Button
              key={minutes}
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  setDetailsExpiry(
                    (await maintenanceApi().updateDiagnosticDetails(minutes)).expiresAt
                  )
                  setReport(await maintenanceApi().diagnose())
                }, "临时详细日志已开启")
              }
            >
              开启 {minutes} 分钟
            </Button>
          ))}
          <Button
            size="sm"
            variant="ghost"
            disabled={busy || detailsExpiry === null}
            onClick={() =>
              void act(async () => {
                setDetailsExpiry((await maintenanceApi().updateDiagnosticDetails(0)).expiresAt)
                setReport(await maintenanceApi().diagnose())
              }, "详细运行信息已关闭")
            }
          >
            立即关闭
          </Button>
        </div>
      </SettingsGroup>
      <SettingsGroup title="诊断包" id="diagnostics-export">
        <p className="text-xs text-muted-foreground">
          导出版本、检查结果和脱敏日志，不含消息、源码、指令、凭据或绝对路径。
        </p>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() =>
            void act(() => maintenanceApi().exportDiagnostics(filter, "diagnostics"), "导出已取消")
          }
        >
          导出诊断包
        </Button>
      </SettingsGroup>
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
                  当前活动运行 {report.activeWork.runs.length}，后台任务{" "}
                  {report.activeWork.tasks.length}，终端 {report.activeWork.terminals.length}
                  。未结束时不可重启。
                </p>
                {[...report.activeWork.runs, ...report.activeWork.tasks].map((work) => (
                  <p key={work.id}>
                    {work.id} · {work.status} ·{" "}
                    <Link
                      className="underline"
                      to="/conversation/$sessionId"
                      params={{ sessionId: work.sessionId }}
                    >
                      前往会话收尾
                    </Link>
                  </p>
                ))}
                {report.activeWork.terminals.map((terminal) => (
                  <p key={terminal.id}>
                    终端 {terminal.id} · {terminal.status}
                  </p>
                ))}
              </div>
            ) : (
              <p className="text-xs text-destructive">
                未获取活动清单；后台将再次检查，未结束时拒绝重启。
              </p>
            )}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setRestartOpen(false)
                void act(() => maintenanceApi().restart(), "后台服务已重启")
              }}
            >
              确认重启
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

import { toast } from "@renderer/lib/toast"
import { useEffect, useState } from "react"
import { ChevronDown } from "lucide-react"
import { Link } from "@tanstack/react-router"
import { Button } from "@renderer/components/ui/button"
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
import type {
  CleanupPreview,
  CleanupResult,
  MaintenanceBackupResult,
  StorageReport,
  StorageRetentionPolicy,
} from "@shared/maintenance-settings-types"
import { AttachmentStorageSettings } from "./attachment-storage-settings"
import { maintenanceApi } from "./usage-settings"
import { errorMessage } from "./settings-error-message"
import { formatBytes } from "./attachment-storage-format"
import { Badge } from "@renderer/components/ui/badge"
import { Input } from "@renderer/components/ui/input"
import { SettingsRow } from "./settings-group"
import { StorageSpaceOverview, StorageRestoreSteps } from "./storage-visuals"

export function StorageSettings() {
  const [report, setReport] = useState<StorageReport | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [source, setSource] = useState("")
  const [target, setTarget] = useState("")
  const [backup, setBackup] = useState<MaintenanceBackupResult | null>(null)
  const [restored, setRestored] = useState("")
  const [restoredSettings, setRestoredSettings] = useState("")
  const [includeMemory, setIncludeMemory] = useState(true)
  const [includeOutput, setIncludeOutput] = useState(false)
  const [cleanupKind, setCleanupKind] = useState<"session" | "log">("session")
  const [days, setDays] = useState("90")
  const [preview, setPreview] = useState<CleanupPreview | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [cleanupResult, setCleanupResult] = useState<CleanupResult | null>(null)
  const [audits, setAudits] = useState<Record<string, unknown>[]>([])
  const [policy, setPolicy] = useState<StorageRetentionPolicy | null>(null)
  const [retentionEditing, setRetentionEditing] = useState(false)
  const [confirmation, setConfirmation] = useState<{
    title: string
    detail: string
    apply: () => Promise<unknown>
  } | null>(null)
  async function act(work: () => Promise<unknown>, message: string) {
    setBusy(true)
    try {
      await work()
      if (message) toast.success(message)
      setError("")
    } catch (error) {
      setError(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }
  async function chooseVerifiedBackup() {
    const directory = await maintenanceApi().chooseDirectory()
    if (!directory) return
    const result = await maintenanceApi().verifyBackup(directory)
    setSource(directory)
    setBackup(result)
  }
  async function scan(notify = true) {
    await act(
      async () => setReport(await maintenanceApi().storage()),
      notify ? "空间统计已刷新" : ""
    )
  }
  useEffect(() => {
    void scan(false)
    void Promise.resolve()
      .then(() => maintenanceApi().cleanupAudits())
      .then((result) => setAudits(result.audits))
      .catch(() => {})
    void Promise.resolve()
      .then(() => maintenanceApi().storagePolicy())
      .then((value) => {
        setPolicy(value)
        setDays(String(value.days))
      })
      .catch(() => {})
  }, [])
  return (
    <div className="flex flex-col gap-10">
      <section id="storage-attachments" aria-label="附件存储">
        <AttachmentStorageSettings />
      </section>
      <section id="storage-space" className="flex flex-col gap-3">
        <div className="flex justify-between gap-3">
          <h2 className="text-sm font-semibold">应用数据空间</h2>
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void scan()}>
              重新扫描
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void act(() => maintenanceApi().openDirectory(), "数据目录已打开")}
            >
              打开数据目录
            </Button>
          </div>
        </div>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
            {report ? " 当前仍显示上次扫描结果。" : ""}
          </p>
        ) : null}

        {!report ? (
          <p role="status" className="text-sm">
            {busy ? "正在扫描应用数据…" : "未取得空间统计"}
          </p>
        ) : (
          <>
            <StorageSpaceOverview report={report} />
          </>
        )}
        <p className="text-xs text-muted-foreground">
          仅统计应用目录。插件数据请在
          <Link className="underline" to="/plugins">
            插件维护入口
          </Link>
          中管理。
        </p>
      </section>
      <details id="storage-retention" className="group border-t pt-5">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-sm text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <span className="flex-1">自动清理</span>
          <Badge variant="outline">
            {policy?.enabled ? `保留 ${policy.days} 天` : policy ? "已关闭" : "状态未知"}
          </Badge>
          <ChevronDown
            className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180 motion-reduce:transition-none"
            aria-hidden="true"
          />
        </summary>
        <div className="mt-5 flex flex-col gap-4">
          <p className="text-xs text-muted-foreground">
            每小时清理已结束的过期会话；恢复数据后自动关闭。
          </p>
          {policy ? (
            <>
              <p className="text-xs">
                已保存：{policy.enabled ? `自动清理开启，保留 ${policy.days} 天` : "自动清理关闭"}
                ；上次执行{" "}
                {policy.lastRunAt ? new Date(policy.lastRunAt).toLocaleString() : "尚未执行"}
              </p>
              {policy.enabled || retentionEditing ? (
                <>
                  <SettingsRow
                    title="保留天数"
                    labelFor="storage-retention-days"
                    control={
                      <Input
                        id="storage-retention-days"
                        aria-label="自动保留天数"
                        type="number"
                        min="1"
                        max="36500"
                        className="w-28"
                        placeholder="默认 90 天"
                        value={days}
                        disabled={busy}
                        onChange={(event) => setDays(event.target.value)}
                      />
                    }
                  />
                  <div className="flex justify-end gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy || !Number.isSafeInteger(Number(days)) || Number(days) < 1}
                      onClick={() =>
                        setConfirmation({
                          title: "启用历史会话自动清理？",
                          detail: `桌面运行时，超过 ${days} 天的非活动会话及子会话将被自动删除，无法撤销；活动、待批准和待收束记录保留。请先备份需要保留的内容。`,
                          apply: async () => {
                            setPolicy(
                              await maintenanceApi().updateStoragePolicy({
                                enabled: true,
                                days: Number(days),
                                expected: { enabled: policy.enabled, days: policy.days },
                              })
                            )
                            setRetentionEditing(false)
                          },
                        })
                      }
                    >
                      保存并启用
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => {
                        if (!policy.enabled) {
                          setRetentionEditing(false)
                          return
                        }
                        void act(async () => {
                          setPolicy(
                            await maintenanceApi().updateStoragePolicy({
                              enabled: false,
                              days: policy.days,
                              expected: { enabled: policy.enabled, days: policy.days },
                            })
                          )
                          setRetentionEditing(false)
                        }, "自动清理已关闭")
                      }}
                    >
                      {policy.enabled ? "关闭自动清理" : "取消设置"}
                    </Button>
                  </div>
                </>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  className="self-start"
                  disabled={busy}
                  onClick={() => setRetentionEditing(true)}
                >
                  设置并启用
                </Button>
              )}
            </>
          ) : (
            <p className="text-xs text-muted-foreground">保留策略读取失败，未启用自动清理。</p>
          )}
        </div>
      </details>
      <details id="storage-cleanup" className="group border-t pt-5">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-sm text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <span className="flex-1">手动清理</span>
          <Badge variant="outline">
            {preview ? `${preview.candidates.length} 个候选` : "会话 / 日志"}
          </Badge>
          <ChevronDown
            className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180 motion-reduce:transition-none"
            aria-hidden="true"
          />
        </summary>
        <div className="mt-5 flex flex-col gap-4">
          <p className="text-xs text-muted-foreground">
            先预览，再勾选删除。进行中的任务、待批准记录和插件数据不会清理。
          </p>
          <div className="settings-filter-grid">
            <label className="flex min-w-0 flex-col gap-2 text-sm">
              类型
              <select
                className="h-8 w-full min-w-0 rounded-lg border border-input bg-background px-2 text-sm"
                value={cleanupKind}
                onChange={(event) => {
                  setCleanupKind(event.target.value as "session" | "log")
                  setPreview(null)
                }}
              >
                <option value="session">历史根会话（含子会话）</option>
                <option value="log">已轮转日志</option>
              </select>
            </label>
            <label className="flex min-w-0 flex-col gap-2 text-sm">
              保留天数
              <Input
                aria-label="清理保留天数"
                className="w-full"
                placeholder="例如 90"
                type="number"
                min="1"
                value={days}
                onChange={(event) => setDays(event.target.value)}
              />
            </label>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !Number.isFinite(Number(days)) || Number(days) < 1}
              onClick={() =>
                void act(async () => {
                  setPreview(
                    await maintenanceApi().cleanupPreview({
                      kind: cleanupKind,
                      olderThan: Date.now() - Number(days) * 86400000,
                    })
                  )
                  setSelected([])
                  setCleanupResult(null)
                }, "清理预览已更新")
              }
            >
              预览候选
            </Button>
          </div>
          {preview ? (
            <>
              <dl className="grid grid-cols-3 gap-4 text-sm">
                <div>
                  <dt className="text-xs text-muted-foreground">待清理</dt>
                  <dd className="mt-1 font-medium tabular-nums">{preview.candidates.length} 项</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">已保护</dt>
                  <dd className="mt-1 font-medium tabular-nums">{preview.protected.length} 项</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">预计回收</dt>
                  <dd className="mt-1 font-medium tabular-nums">{formatBytes(preview.bytes)}</dd>
                </div>
              </dl>
              <p className="text-xs text-muted-foreground">清理范围：{preview.scope}</p>
              <div className="max-h-72 divide-y overflow-auto">
                {preview.candidates.map((candidate) => (
                  <label key={candidate.id} className="flex items-start gap-3 py-2 text-xs">
                    <input
                      type="checkbox"
                      checked={selected.includes(candidate.id)}
                      onChange={(event) =>
                        setSelected((previous) =>
                          event.target.checked
                            ? [...previous, candidate.id]
                            : previous.filter((id) => id !== candidate.id)
                        )
                      }
                    />
                    <span>
                      {candidate.label} · {new Date(candidate.updatedAt).toLocaleString()} ·{" "}
                      {candidate.kind === "session"
                        ? `${candidate.children ?? 0} 个子会话，${candidate.attachments ?? 0} 条附件引用`
                        : formatBytes(candidate.bytes)}
                      <br />
                      <span className="text-muted-foreground">{candidate.id}</span>
                    </span>
                  </label>
                ))}
              </div>
              {preview.protected.length ? (
                <details>
                  <summary className="text-xs">已保护 {preview.protected.length} 项</summary>
                  {preview.protected.map((item) => (
                    <p key={item.id} className="text-xs text-muted-foreground">
                      {item.id}：{item.reason}
                    </p>
                  ))}
                </details>
              ) : null}
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={busy || !selected.length}
                  onClick={() =>
                    setConfirmation({
                      title: "删除已勾选的应用数据？",
                      detail: `将删除 ${selected.length} 个所选对象。历史会话包含子会话，删除后不能从本机撤销。附件物理文件单独按引用保护规则清理。执行时再次核对状态；已改变对象跳过。`,
                      apply: async () => {
                        setCleanupResult(
                          await maintenanceApi().cleanupExecute({
                            previewId: preview.id,
                            ids: selected,
                          })
                        )
                        setPreview(null)
                        setSelected([])
                        setAudits((await maintenanceApi().cleanupAudits()).audits)
                        setReport(await maintenanceApi().storage())
                      },
                    })
                  }
                >
                  删除所选
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    setPreview(null)
                    setSelected([])
                  }}
                >
                  取消
                </Button>
              </div>
            </>
          ) : null}
          {cleanupResult ? (
            <div className="text-xs">
              <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                {[
                  ["已删除", cleanupResult.completed.length],
                  ["已跳过", cleanupResult.skipped.length],
                  ["失败", cleanupResult.failures.length],
                  ["已回收", formatBytes(cleanupResult.releasedBytes)],
                ].map(([label, value]) => (
                  <div key={label}>
                    <dt className="text-muted-foreground">{label}</dt>
                    <dd className="mt-1 text-sm font-medium tabular-nums">{value}</dd>
                  </div>
                ))}
              </dl>
              <p className="mt-3 text-muted-foreground">记录：{cleanupResult.auditId}</p>
              {[...cleanupResult.skipped, ...cleanupResult.failures].map((item) => (
                <p key={item.id} className="text-muted-foreground">
                  {item.id}：{item.reason}
                </p>
              ))}
            </div>
          ) : null}
          <details>
            <summary className="text-xs">清理记录（{audits.length}）</summary>
            {audits.map((audit, index) => (
              <p key={index} className="py-1 text-xs text-muted-foreground">
                {new Date(Number(audit.createdAt)).toLocaleString()} · {String(audit.state)} ·{" "}
                {String((audit.result as { auditId?: string } | undefined)?.auditId ?? "")}
              </p>
            ))}
          </details>
        </div>
      </details>
      <details id="storage-backup" className="group border-t pt-5">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-sm text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <span className="flex-1">备份与校验</span>
          <Badge variant="outline">
            {report?.backups?.length ? `${report.backups.length} 份备份` : "本地备份"}
          </Badge>
          <ChevronDown
            className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180 motion-reduce:transition-none"
            aria-hidden="true"
          />
        </summary>
        <div className="mt-5 flex flex-col gap-4">
          <p className="text-xs text-muted-foreground">请先结束任务。凭据和用户指令不备份。</p>
          <div className="flex flex-wrap gap-2" aria-label="备份默认内容">
            {["会话", "便签", "附件", "非机密设置"].map((label) => (
              <Badge key={label} variant="secondary">
                {label}
              </Badge>
            ))}
          </div>
          <label className="flex gap-2 text-xs">
            <input
              type="checkbox"
              checked={includeMemory}
              onChange={(event) => setIncludeMemory(event.target.checked)}
            />
            包含项目和会话记忆
          </label>
          <label className="flex gap-2 text-xs">
            <input
              type="checkbox"
              checked={includeOutput}
              onChange={(event) => setIncludeOutput(event.target.checked)}
            />
            包含运行输出
          </label>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  const destination = await maintenanceApi().chooseDirectory()
                  if (!destination) return
                  const result = await maintenanceApi().backup({
                    destination,
                    includeMemory,
                    includeOutput,
                  })
                  setBackup(result)
                  setSource(result.path)
                  setReport(await maintenanceApi().storage())
                }, "备份操作结束")
              }
            >
              创建备份
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void act(chooseVerifiedBackup, "备份校验结束")}
            >
              校验备份
            </Button>
          </div>
          {backup ? (
            <div className="text-xs text-muted-foreground">
              <p className="break-all">已校验清单：{backup.path}</p>
              <p>
                {new Date(backup.manifest.createdAt).toLocaleString()} · 格式{" "}
                {backup.manifest.version} · 总大小{" "}
                {backup.totalBytes === undefined ? "未记录" : formatBytes(backup.totalBytes)} · 包含{" "}
                {Object.entries(backup.manifest.directories)
                  .filter(([, included]) => included)
                  .map(([name]) => name)
                  .join("、")}
              </p>
            </div>
          ) : null}
          <details>
            <summary className="text-xs">备份创建记录（{report?.backups?.length ?? 0}）</summary>
            {report?.backups?.map((item) => (
              <div
                key={item.manifest.backupId}
                className="flex items-start justify-between gap-3 py-2 text-xs"
              >
                <p className="break-all">
                  {new Date(item.createdAt).toLocaleString()} · {formatBytes(item.bytes)} ·
                  已完成校验
                  <br />
                  {item.path}
                  <br />
                  包含{" "}
                  {Object.entries(item.manifest.directories)
                    .filter(([, included]) => included)
                    .map(([name]) => name)
                    .join("、")}
                </p>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      const result = await maintenanceApi().verifyBackup(item.path)
                      setBackup(result)
                      setSource(result.path)
                    }, "备份已重新校验")
                  }
                >
                  校验并选择
                </Button>
              </div>
            ))}
          </details>
        </div>
      </details>
      <details id="storage-restore" className="group border-t pt-5">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-sm text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <span className="flex-1">恢复与切换</span>
          <Badge variant="outline">{restored ? "可切换" : "恢复到新目录"}</Badge>
        </summary>
        <div className="mt-5 flex flex-col gap-4">
          <p className="text-xs text-muted-foreground">
            不覆盖当前数据，不续跑旧任务；切换失败自动回退。
          </p>
          <StorageRestoreSteps source={source} target={target} restored={restored} />
          {source || target || restored ? (
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer">查看所选路径</summary>
              <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-2">
                <dt>备份</dt>
                <dd className="break-all">{source || "未选择"}</dd>
                <dt>目标</dt>
                <dd className="break-all">{target || "未选择"}</dd>
                {restored ? (
                  <>
                    <dt>恢复数据</dt>
                    <dd className="break-all">{restored}</dd>
                  </>
                ) : null}
              </dl>
            </details>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void act(chooseVerifiedBackup, "备份已校验")}
            >
              选择备份
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  const directory = await maintenanceApi().chooseDirectory()
                  if (directory) setTarget(directory)
                }, "恢复目标已选择")
              }
            >
              选择空目录
            </Button>
            <Button
              size="sm"
              disabled={busy || !source || !target}
              onClick={() =>
                setConfirmation({
                  title: "恢复所选备份？",
                  detail: `备份 ${source}；目标 ${target}。只写入空目标，不改变正在使用的数据。`,
                  apply: async () => {
                    const result = await maintenanceApi().restore({ source, target })
                    setRestored(result.path)
                    setRestoredSettings(result.settingsSnapshotPath ?? "")
                  },
                })
              }
            >
              恢复到新目录
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !restored}
              onClick={() =>
                setConfirmation({
                  title: "切换到恢复数据？",
                  detail: `后台将安全关闭并改用 ${restored}。原数据保留；活动任务或终端尚未收尾时拒绝切换。系统常驻服务请先停用。`,
                  apply: async () => {
                    await maintenanceApi().switchData(restored)
                    try {
                      setReport(await maintenanceApi().storage())
                      const nextPolicy = await maintenanceApi().storagePolicy()
                      setPolicy(nextPolicy)
                      setDays(String(nextPolicy.days))
                    } catch (error) {
                      throw new Error(
                        `数据已切换，但维护状态刷新失败：${errorMessage(error)}。仍显示上次扫描结果。`
                      )
                    }
                  },
                })
              }
            >
              切换到恢复数据
            </Button>
          </div>
          {restoredSettings ? (
            <p className="text-xs break-all text-muted-foreground">
              非机密配置快照已恢复：{restoredSettings}。在
              <Link className="underline" to="/settings/$section" params={{ section: "general" }}>
                常规页导入配置
              </Link>
              恢复所需分类。设备偏好保持不变，凭据需重新配置。
            </p>
          ) : null}
        </div>
      </details>
      <AlertDialog
        open={confirmation !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmation(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmation?.title}</AlertDialogTitle>
            <AlertDialogDescription>{confirmation?.detail}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const action = confirmation
                setConfirmation(null)
                if (action) void act(action.apply, "操作完成")
              }}
            >
              确认
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

import { SettingsGroup } from "./settings-group"
import { useCallback, useEffect, useRef, useState } from "react"
import { Button } from "@renderer/components/ui/button"
import { Input } from "@renderer/components/ui/input"
import { Switch } from "@renderer/components/ui/switch"
import { Alert, AlertDescription } from "@renderer/components/ui/alert"
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "@renderer/components/ui/alert-dialog"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@renderer/components/ui/select"
import { useDesktopSessionStore } from "@renderer/stores/desktop-session"
import type {
  GitDetection,
  GitIdentity,
  GitPreferences,
  GitSettingsSnapshot,
} from "@shared/git-settings-types"
import { errorMessage } from "./settings-error-message"

export function GitSettings() {
  const projects = useDesktopSessionStore((state) => state.projects)
  const [projectId, setProjectId] = useState<string | undefined>()
  const [environment, setEnvironment] = useState<"native" | "wsl">("native")
  const [snapshot, setSnapshot] = useState<GitSettingsSnapshot | null>(null)
  const [draft, setDraft] = useState<GitPreferences | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [feedback, setFeedback] = useState("")
  const [confirmation, setConfirmation] = useState<{ text: string; apply(): Promise<void> } | null>(
    null
  )
  const version = useRef(0)
  const locked = useRef(false)
  const reload = useCallback(async () => {
    const request = ++version.current
    const value = await window.desktop.gitSettings.snapshot({ projectId, environment })
    if (request !== version.current) return
    setSnapshot(value)
    setDraft(value.preferences)
  }, [projectId, environment])
  useEffect(() => {
    setSnapshot(null)
    void reload().catch((failure) => setError(errorMessage(failure)))
    return () => {
      version.current++
    }
  }, [reload])
  async function run(operation: () => Promise<void>, success: string) {
    if (locked.current) return
    locked.current = true
    setBusy(true)
    setError("")
    setFeedback("")
    try {
      await operation()
      setFeedback(success)
      return true
    } catch (failure) {
      setError(errorMessage(failure))
      return false
    } finally {
      locked.current = false
      setBusy(false)
    }
  }
  async function preference(patch: Partial<GitPreferences>) {
    if (!snapshot) return
    await run(async () => {
      const preferences = await window.desktop.gitSettings.updatePreferences({
        preferences: { ...snapshot.preferences, ...patch },
        expected: snapshot.preferences,
      })
      setSnapshot({ ...snapshot, preferences })
      setDraft(preferences)
    }, "已保存，新差异面板和任务生效。")
  }
  return (
    <div className="settings-content-column">
      <header>
        <h1 className="text-xl font-semibold">Git</h1>
        <p className="mt-2 text-sm text-muted-foreground">暂存和提交在项目中完成。</p>
      </header>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>
            {error}{" "}
            <Button variant="ghost" onClick={() => void run(reload, "已重新读取。")}>
              重新读取
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {feedback && (
        <p role="status" className="text-xs text-muted-foreground">
          {feedback}
        </p>
      )}
      <SettingsGroup
        title="实际 Git 环境"
        data-setting-id="git-detection"
        action={
          <Button variant="ghost" disabled={busy} onClick={() => void run(reload, "检测完成。")}>
            重新检测
          </Button>
        }
      >
        <label className="settings-form-row text-sm">
          所选项目
          <Select
            value={projectId ?? "global"}
            onValueChange={(value) => setProjectId(value && value !== "global" ? value : undefined)}
            disabled={busy}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="global">用户默认 / 不选择项目</SelectItem>
                {projects.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </label>
        {!snapshot ? (
          <p role="status" className="text-sm text-muted-foreground">
            {error ? "Git 设置尚未读取。" : "正在读取 Git 设置…"}
          </p>
        ) : (
          <>
            <Detection label="桌面差异读取（本机）" value={snapshot.desktopGit} />
            <Detection
              label={`新任务 Git · ${snapshot.agentEnvironmentSource}`}
              value={snapshot.agentGit}
            />
            {snapshot.errors.map((item) => (
              <p key={item} className="text-xs text-destructive">
                {item}
              </p>
            ))}
          </>
        )}
      </SettingsGroup>
      {snapshot && draft && (
        <>
          <SettingsGroup title="提交身份" data-setting-id="git-identity">
            <label className="settings-form-row text-sm">
              编辑所在环境
              <Select
                value={environment}
                onValueChange={(value) => {
                  if (value === "native" || value === "wsl") setEnvironment(value)
                }}
                disabled={busy}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="native">本机 Git</SelectItem>
                    <SelectItem value="wsl">WSL Git</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </label>
            <p className="text-xs text-muted-foreground">
              项目身份优先于全局身份；环境变量仍可覆盖。
            </p>
            <IdentityEditor
              key={`global-${environment}-${projectId}`}
              label="用户全局身份"
              identity={snapshot.globalIdentity}
              busy={busy}
              save={(name, email, expected) =>
                run(async () => {
                  const next = await window.desktop.gitSettings.updateIdentity({
                    projectId,
                    environment,
                    scope: "global",
                    name,
                    email,
                    expectedName: expected.configuredName,
                    expectedEmail: expected.configuredEmail,
                  })
                  setSnapshot(next)
                }, "全局身份已保存。")
              }
            />
            {projectId ? (
              snapshot.repository ? (
                <IdentityEditor
                  key={`project-${environment}-${projectId}`}
                  label="选定项目身份"
                  identity={snapshot.projectIdentity}
                  busy={busy}
                  save={(name, email, expected) =>
                    run(async () => {
                      const next = await window.desktop.gitSettings.updateIdentity({
                        projectId,
                        environment,
                        scope: "project",
                        name,
                        email,
                        expectedName: expected.configuredName,
                        expectedEmail: expected.configuredEmail,
                      })
                      setSnapshot(next)
                    }, "项目身份已保存。")
                  }
                />
              ) : (
                <p className="text-sm text-muted-foreground">当前环境中项目不是可用的 Git 仓库。</p>
              )
            ) : null}
          </SettingsGroup>
          <SettingsGroup title="差异显示" data-setting-id="git-diff">
            <label className="flex items-center justify-between text-sm">
              新打开面板的默认范围
              <Select
                value={snapshot.preferences.defaultScope}
                disabled={busy}
                onValueChange={(value) => {
                  if (value === "staged" || value === "unstaged" || value === "uncommitted")
                    void preference({ defaultScope: value })
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="uncommitted">全部未提交</SelectItem>
                    <SelectItem value="staged">仅已暂存</SelectItem>
                    <SelectItem value="unstaged">仅未暂存</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </label>
            <label className="flex items-center justify-between text-sm">
              显示方式
              <Select
                value={snapshot.preferences.viewMode}
                disabled={busy}
                onValueChange={(value) => {
                  if (value === "unified" || value === "split") void preference({ viewMode: value })
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="unified">统一视图</SelectItem>
                    <SelectItem value="split">左右对照</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </label>
            <label className="flex items-center justify-between text-sm">
              忽略纯空白变化
              <Switch
                checked={snapshot.preferences.ignoreWhitespace}
                disabled={busy}
                onCheckedChange={(value) => void preference({ ignoreWhitespace: value })}
              />
            </label>
            <p className="text-xs text-muted-foreground">仅影响显示。</p>
          </SettingsGroup>
          <SettingsGroup title="分支与独立工作目录" data-setting-id="git-worktrees">
            <p className="text-xs text-muted-foreground">
              独立目录让任务在不同分支执行；创建失败不会改用原目录。
            </p>
            <label className="settings-form-row text-sm">
              新建分支前缀
              <Input
                placeholder="例如 task/"
                value={draft.branchPrefix}
                disabled={busy}
                onChange={(event) => setDraft({ ...draft, branchPrefix: event.target.value })}
              />
            </label>
            <Button
              disabled={busy || draft.branchPrefix === snapshot.preferences.branchPrefix}
              onClick={() => void preference({ branchPrefix: draft.branchPrefix })}
            >
              保存分支前缀
            </Button>
            <label className="flex items-center justify-between text-sm">
              新任务默认位置
              <Select
                value={snapshot.preferences.defaultTaskLocation}
                disabled={busy}
                onValueChange={(value) => {
                  if (value === "current" || value === "worktree")
                    void preference({ defaultTaskLocation: value })
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="current">当前目录</SelectItem>
                    <SelectItem value="worktree">独立工作目录</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </label>
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <span className="min-w-0 break-all">
                目录位置：{snapshot.preferences.worktreeRoot ?? "系统管理的任务目录"}
              </span>
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const path = await window.desktop.gitSettings.chooseDirectory()
                    if (path) {
                      const preferences = await window.desktop.gitSettings.updatePreferences({
                        preferences: { ...snapshot.preferences, worktreeRoot: path },
                        expected: snapshot.preferences,
                      })
                      setSnapshot({ ...snapshot, preferences })
                      setDraft(preferences)
                    }
                  }, "目录选择完成。")
                }
              >
                选择专用目录
              </Button>
              {snapshot.preferences.worktreeRoot && (
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => void preference({ worktreeRoot: null })}
                >
                  使用系统目录
                </Button>
              )}
            </div>
            <label className="flex items-center justify-between text-sm">
              自动清理安全的已结束目录
              <Switch
                checked={snapshot.preferences.autoCleanup}
                disabled={busy}
                onCheckedChange={(value) => void preference({ autoCleanup: value })}
              />
            </label>
            <p className="text-xs text-muted-foreground">
              仅清理 Vykor 创建、任务已结束且无未提交改动的目录；成果须已保留或明确放弃。
            </p>
            {snapshot.worktrees.length === 0 ? (
              <p className="text-sm text-muted-foreground">没有 Vykor 管理的独立工作目录。</p>
            ) : (
              snapshot.worktrees.map((item) => (
                <div key={item.id} className="space-y-2 border-b border-border py-3 text-sm">
                  <p>
                    {projects.find((project) => project.id === item.projectId)?.name ??
                      item.projectPath}{" "}
                    · {item.task ?? "未绑定任务"}
                  </p>
                  <p className="font-mono text-xs break-all">
                    {item.branch} · {item.path}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {item.bytes === null
                      ? "占用未知"
                      : `${(item.bytes / 1024 / 1024).toFixed(1)} MB`}{" "}
                    · {item.reason}
                  </p>
                  <div className="flex gap-2">
                    {!item.preserved && !item.active && item.dirty === false && (
                      <Button
                        variant="ghost"
                        disabled={busy}
                        onClick={() =>
                          setConfirmation({
                            text: `确认 ${item.path} 的分支成果可以删除？此标记允许清理独立工作目录；分支会保留。`,
                            apply: async () => {
                              await window.desktop.gitSettings.markDisposable({
                                id: item.id,
                                disposable: true,
                              })
                              await reload()
                            },
                          })
                        }
                      >
                        明确允许清理
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      disabled={busy || !item.cleanupAllowed}
                      onClick={() =>
                        setConfirmation({
                          text: item.directoryRemoved
                            ? `${item.path} 已经清理，重试只刷新会话绑定；不会删除目录或 Git 分支。`
                            : `清理 ${item.path}？已确认任务结束、没有未提交改动，${item.preserved ? "成果已保留" : "已明确允许删除"}。Git 分支保留。`,
                          apply: async () => {
                            await window.desktop.gitSettings.cleanup({ id: item.id })
                            await reload()
                          },
                        })
                      }
                    >
                      {item.directoryRemoved ? "刷新绑定" : "清理目录"}
                    </Button>
                  </div>
                </div>
              ))
            )}
          </SettingsGroup>
        </>
      )}
      <AlertDialog
        open={confirmation !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmation(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认清理范围</AlertDialogTitle>
            <AlertDialogDescription>{confirmation?.text}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const current = confirmation
                setConfirmation(null)
                if (current) void run(current.apply, "独立目录状态已更新。")
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
function Detection({ label, value }: { label: string; value: GitDetection }) {
  return (
    <div className="space-y-1 text-sm">
      <p>
        {label} ·{" "}
        {value.environment === "wsl" ? `WSL ${value.distribution ?? "默认发行版"}` : "本机"}
      </p>
      <p className="text-xs break-all text-muted-foreground">
        {value.available ? `${value.version} · ${value.executable}` : `不可用：${value.error}`}
      </p>
    </div>
  )
}
function IdentityEditor({
  label,
  identity,
  busy,
  save,
}: {
  label: string
  identity: GitIdentity | null
  busy: boolean
  save(name: string, email: string, expected: GitIdentity): Promise<boolean | undefined>
}) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState("")
  const [email, setEmail] = useState("")
  return (
    <div className="flex flex-col gap-3 text-sm">
      <p className="font-medium">{label}</p>
      {identity ? (
        editing ? (
          <>
            <label className="settings-form-row">
              提交姓名
              <Input
                placeholder="提交时显示的姓名"
                value={name}
                onChange={(event) => setName(event.target.value)}
                disabled={busy}
              />
            </label>
            <label className="settings-form-row">
              提交邮箱
              <Input
                type="email"
                placeholder="name@example.com"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                disabled={busy}
              />
            </label>
            <div className="flex gap-2">
              <Button
                disabled={busy || !name.trim() || !email.trim()}
                onClick={() =>
                  void save(name, email, identity).then((saved) => {
                    if (saved) setEditing(false)
                  })
                }
              >
                保存{label}
              </Button>
              <Button variant="ghost" disabled={busy} onClick={() => setEditing(false)}>
                取消
              </Button>
            </div>
          </>
        ) : (
          <>
            <p>
              {identity.name.value || "未配置姓名"} · {identity.email.value || "未配置邮箱"}
            </p>
            <p className="text-xs break-all text-muted-foreground">
              姓名来源：{identity.name.source}；邮箱来源：{identity.email.source}
            </p>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setName(identity.configuredName)
                setEmail(identity.configuredEmail)
                setEditing(true)
              }}
            >
              编辑{label}
            </Button>
          </>
        )
      ) : (
        <p className="text-xs text-muted-foreground">Git 身份不可读取，请查看上方检测结果。</p>
      )}
    </div>
  )
}

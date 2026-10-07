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
import { useDesktopSessionStore } from "@renderer/stores/desktop-session"
import type {
  GitDetection,
  GitIdentity,
  GitPreferences,
  GitSettingsSnapshot,
} from "@shared/git-settings-types"
import { toast } from "@renderer/lib/toast"
import { SettingsGroup, SettingsRow, SettingsSelect, SettingsFoldout } from "./settings-group"
import { SettingsStatus } from "./settings-status"
import { errorMessage } from "./settings-error-message"

export function GitSettings() {
  const projects = useDesktopSessionStore((state) => state.projects)
  const [projectId, setProjectId] = useState<string | undefined>()
  const [environment, setEnvironment] = useState<"native" | "wsl">("native")
  const [snapshot, setSnapshot] = useState<GitSettingsSnapshot | null>(null)
  const [draft, setDraft] = useState<GitPreferences | null>(null)
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("")
  const [identityEditing, setIdentityEditing] = useState(false)
  const [confirmation, setConfirmation] = useState<{
    title?: string
    text: string
    apply(): Promise<void>
  } | null>(null)
  const version = useRef(0),
    locked = useRef(false)
  const reload = useCallback(async () => {
    const request = ++version.current
    const value = await window.desktop.gitSettings.snapshot({ projectId, environment })
    if (request !== version.current) return
    setSnapshot(value)
    setDraft(value.preferences)
    setError("")
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
    try {
      await operation()
      if (success) toast.success(success)
      return true
    } catch (failure) {
      setError(errorMessage(failure))
      return false
    } finally {
      locked.current = false
      setBusy(false)
    }
  }
  async function persistPreference(patch: Partial<GitPreferences>) {
    if (!snapshot) return
    const preferences = await window.desktop.gitSettings.updatePreferences({
      preferences: { ...snapshot.preferences, ...patch },
      expected: snapshot.preferences,
    })
    setSnapshot({ ...snapshot, preferences })
    setDraft((current) => ({
      ...preferences,
      branchPrefix:
        patch.branchPrefix === undefined
          ? (current?.branchPrefix ?? preferences.branchPrefix)
          : preferences.branchPrefix,
    }))
  }
  async function preference(patch: Partial<GitPreferences>) {
    await run(() => persistPreference(patch), "已保存，新差异面板和任务生效。")
  }
  const prefixDirty = Boolean(
    snapshot && draft && draft.branchPrefix !== snapshot.preferences.branchPrefix
  )
  function changeScope(next: string) {
    const apply = async () => setProjectId(next === "global" ? undefined : next)
    if (prefixDirty) setConfirmation({ text: "切换范围会放弃未保存的分支前缀，是否继续？", apply })
    else void apply()
  }
  async function saveIdentity(
    scope: "global" | "project",
    name: string,
    email: string,
    expected: GitIdentity
  ) {
    return run(async () => {
      const next = await window.desktop.gitSettings.updateIdentity({
        projectId,
        environment,
        scope,
        name,
        email,
        expectedName: expected.configuredName,
        expectedEmail: expected.configuredEmail,
      })
      setSnapshot(next)
    }, "提交身份已保存。")
  }
  return (
    <div className="settings-content-column" aria-busy={busy}>
      <header>
        <h1 className="text-xl font-semibold">Git</h1>
        <p className="pb-3 text-xs text-muted-foreground">设置查看差异和执行任务时的默认方式。</p>
      </header>
      <SettingsRow
        title="设置范围"
        control={
          <SettingsSelect
            label="Git 设置范围"
            value={projectId ?? "global"}
            options={[
              { value: "global", label: "用户默认" },
              ...projects.map((project) => ({ value: project.id, label: project.name })),
            ]}
            disabled={busy || identityEditing}
            onChange={changeScope}
          />
        }
      />
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <SettingsGroup
        title="Git 可用状态"
        separated
        action={
          <Button
            size="sm"
            variant="ghost"
            disabled={busy || identityEditing}
            onClick={() => {
              if (prefixDirty)
                setConfirmation({
                  text: "重新检测会放弃未保存的分支前缀，是否继续？",
                  apply: reload,
                })
              else void run(reload, "检测完成。")
            }}
          >
            重新检测
          </Button>
        }
      >
        {!snapshot ? (
          <p role="status" className="py-4 text-sm text-muted-foreground">
            {error ? "Git 设置尚未读取。" : "正在检测 Git…"}
          </p>
        ) : (
          <>
            <Detection label="桌面差异" value={snapshot.desktopGit} />
            <Detection
              label="智能体任务"
              value={snapshot.agentGit}
              source={snapshot.agentEnvironmentSource}
            />
            {snapshot.errors.length ? (
              <div className="py-3 text-xs text-destructive">
                {snapshot.errors.map((item) => (
                  <p key={item}>{item}</p>
                ))}
              </div>
            ) : null}
          </>
        )}
      </SettingsGroup>
      {snapshot && draft ? (
        <>
          <SettingsGroup
            title="差异显示"
            separated
            description="更改自动保存，仅影响新打开的差异面板。"
          >
            <SettingsRow
              title="默认查看范围"
              control={
                <SettingsSelect
                  label="默认查看范围"
                  value={snapshot.preferences.defaultScope}
                  disabled={busy}
                  options={[
                    { value: "uncommitted", label: "全部未提交" },
                    { value: "staged", label: "仅已暂存" },
                    { value: "unstaged", label: "仅未暂存" },
                  ]}
                  onChange={(value) =>
                    void preference({ defaultScope: value as GitPreferences["defaultScope"] })
                  }
                />
              }
            />
            <SettingsRow
              title="显示方式"
              control={
                <SettingsSelect
                  label="显示方式"
                  value={snapshot.preferences.viewMode}
                  disabled={busy}
                  options={[
                    { value: "unified", label: "单栏视图" },
                    { value: "split", label: "左右对照" },
                  ]}
                  onChange={(value) =>
                    void preference({ viewMode: value as GitPreferences["viewMode"] })
                  }
                />
              }
            />
            <SettingsRow
              title="忽略纯空白变化"
              description="不改变文件内容。"
              control={
                <Switch
                  aria-label="忽略纯空白变化"
                  disabled={busy}
                  checked={snapshot.preferences.ignoreWhitespace}
                  onCheckedChange={(value) => void preference({ ignoreWhitespace: value })}
                />
              }
            />
          </SettingsGroup>
          <SettingsGroup title="提交身份" separated>
            <SettingsRow
              title="身份所在环境"
              control={
                <SettingsSelect
                  label="身份所在环境"
                  value={environment}
                  options={[
                    { value: "native", label: "本机 Git" },
                    { value: "wsl", label: "WSL Git" },
                  ]}
                  disabled={busy || identityEditing}
                  onChange={(value) => setEnvironment(value as "native" | "wsl")}
                />
              }
            />
            <IdentityEditor
              key={`global-${environment}-${projectId}`}
              label="用户全局身份"
              identity={snapshot.globalIdentity}
              busy={busy}
              onEditingChange={setIdentityEditing}
              editingLocked={identityEditing}
              save={(name, email, expected) => saveIdentity("global", name, email, expected)}
            />
            {projectId ? (
              snapshot.repository ? (
                <IdentityEditor
                  key={`project-${environment}-${projectId}`}
                  label="项目提交身份"
                  identity={snapshot.projectIdentity}
                  busy={busy}
                  onEditingChange={setIdentityEditing}
                  editingLocked={identityEditing}
                  save={(name, email, expected) => saveIdentity("project", name, email, expected)}
                />
              ) : (
                <p className="py-3 text-xs text-muted-foreground">
                  此项目在所选环境中不是可用的 Git 仓库。
                </p>
              )
            ) : null}
          </SettingsGroup>
          <SettingsGroup title="任务工作目录" separated>
            <SettingsRow
              title="新任务默认位置"
              description="独立目录让任务在不同分支执行，创建失败不会改用原目录。"
              control={
                <SettingsSelect
                  label="新任务默认位置"
                  value={snapshot.preferences.defaultTaskLocation}
                  disabled={busy}
                  options={[
                    { value: "current", label: "当前项目目录" },
                    { value: "worktree", label: "独立工作目录" },
                  ]}
                  onChange={(value) =>
                    void preference({
                      defaultTaskLocation: value as GitPreferences["defaultTaskLocation"],
                    })
                  }
                />
              }
            />
          </SettingsGroup>
          <SettingsFoldout title="高级选项" id="git-advanced">
            <SettingsGroup title="独立目录设置" separated>
              <SettingsRow
                title="新建分支前缀"
                labelFor="git-branch-prefix"
                control={
                  <div className="flex items-center gap-2">
                    <Input
                      id="git-branch-prefix"
                      className="w-40"
                      placeholder="例如 task/"
                      value={draft.branchPrefix}
                      disabled={busy}
                      onChange={(event) => setDraft({ ...draft, branchPrefix: event.target.value })}
                    />
                    {prefixDirty ? (
                      <>
                        <Button
                          size="sm"
                          disabled={busy}
                          onClick={() => void preference({ branchPrefix: draft.branchPrefix })}
                        >
                          保存
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() =>
                            setDraft({ ...draft, branchPrefix: snapshot.preferences.branchPrefix })
                          }
                        >
                          取消
                        </Button>
                      </>
                    ) : null}
                  </div>
                }
              />
              <SettingsRow
                title="目录位置"
                description={snapshot.preferences.worktreeRoot ?? "使用系统管理的任务目录。"}
                control={
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          const path = await window.desktop.gitSettings.chooseDirectory()
                          if (path) {
                            await persistPreference({ worktreeRoot: path })
                            toast.success("目录设置已保存。")
                          }
                        }, "")
                      }
                    >
                      选择目录
                    </Button>
                    {snapshot.preferences.worktreeRoot ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => void preference({ worktreeRoot: null })}
                      >
                        恢复默认
                      </Button>
                    ) : null}
                  </div>
                }
              />
              <SettingsRow
                title="自动清理已结束目录"
                description="仅清理任务已结束、无未提交改动且成果已保留或明确放弃的目录。"
                control={
                  <Switch
                    aria-label="自动清理已结束目录"
                    checked={snapshot.preferences.autoCleanup}
                    disabled={busy}
                    onCheckedChange={(value) => {
                      if (value)
                        setConfirmation({
                          title: "启用独立目录自动清理？",
                          text: "开启后自动清理满足安全条件的已结束任务目录。未提交改动、活动任务和未确认成果不会清理，Git 分支保留。",
                          apply: () => persistPreference({ autoCleanup: true }),
                        })
                      else void preference({ autoCleanup: false })
                    }}
                  />
                }
              />
            </SettingsGroup>
            <SettingsGroup title={`独立工作目录（${snapshot.worktrees.length}）`}>
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
          </SettingsFoldout>
        </>
      ) : null}
      <AlertDialog
        open={confirmation !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setConfirmation(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmation?.title ?? "确认 Git 操作"}</AlertDialogTitle>
            <AlertDialogDescription>{confirmation?.text}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={() => {
                const current = confirmation
                setConfirmation(null)
                if (current) void run(current.apply, "操作已完成。")
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
function Detection({
  label,
  value,
  source,
}: {
  label: string
  value: GitDetection
  source?: string
}) {
  return (
    <div>
      <SettingsRow
        title={label}
        description={
          value.available
            ? `${value.environment === "wsl" ? `WSL · ${value.distribution ?? "系统默认发行版"}` : "本机"} · ${value.version?.replace("git version ", "") ?? "版本未知"}${source ? ` · ${source}` : ""}`
            : (value.error ?? "未检测到 Git。")
        }
        control={
          <SettingsStatus tone={value.available ? "success" : "error"}>
            {value.available ? "可用" : "不可用"}
          </SettingsStatus>
        }
      />
      {value.executable ? (
        <details className="mt-2 text-xs text-muted-foreground">
          <summary className="cursor-pointer">查看执行路径</summary>
          <p className="mt-2 break-all">{value.executable}</p>
        </details>
      ) : null}
    </div>
  )
}
function IdentityEditor({
  label,
  identity,
  busy,
  save,
  onEditingChange,
  editingLocked,
}: {
  label: string
  identity: GitIdentity | null
  busy: boolean
  save(name: string, email: string, expected: GitIdentity): Promise<boolean | undefined>
  onEditingChange(editing: boolean): void
  editingLocked: boolean
}) {
  const [editing, setEditing] = useState(false),
    [name, setName] = useState(""),
    [email, setEmail] = useState("")
  function close() {
    setEditing(false)
    onEditingChange(false)
  }
  return (
    <div className="py-3">
      <SettingsRow
        title={label}
        description={
          identity
            ? `${identity.name.value || "未配置姓名"} · ${identity.email.value || "未配置邮箱"}`
            : "身份暂不可读取，请先检查 Git 状态。"
        }
        control={
          identity && !editing ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy || editingLocked}
              onClick={() => {
                setName(identity.configuredName)
                setEmail(identity.configuredEmail)
                setEditing(true)
                onEditingChange(true)
              }}
            >
              编辑
            </Button>
          ) : null
        }
      />
      {identity && editing ? (
        <div className="flex flex-col gap-3">
          <SettingsRow
            title="提交姓名"
            labelFor={`${label}-name`}
            control={
              <Input
                id={`${label}-name`}
                className="w-56"
                value={name}
                placeholder="提交时显示的姓名"
                disabled={busy}
                onChange={(event) => setName(event.target.value)}
              />
            }
          />
          <SettingsRow
            title="提交邮箱"
            labelFor={`${label}-email`}
            control={
              <Input
                id={`${label}-email`}
                className="w-56"
                type="email"
                value={email}
                placeholder="name@example.com"
                disabled={busy}
                onChange={(event) => setEmail(event.target.value)}
              />
            }
          />
          <div className="flex justify-end gap-2">
            <Button
              size="sm"
              disabled={busy || !name.trim() || !email.trim()}
              onClick={() =>
                void save(name, email, identity).then((saved) => {
                  if (saved) close()
                })
              }
            >
              保存身份
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={close}>
              取消
            </Button>
          </div>
        </div>
      ) : identity ? (
        <details className="mt-2 text-xs text-muted-foreground">
          <summary className="cursor-pointer">来源与配置详情</summary>
          <p className="mt-2 break-all">姓名来源：{identity.name.source}</p>
          <p className="mt-1 break-all">邮箱来源：{identity.email.source}</p>
        </details>
      ) : null}
    </div>
  )
}

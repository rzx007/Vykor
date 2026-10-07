import { useCallback, useEffect, useRef, useState } from "react"
import type { MemoryEntryRecord } from "@vykor/client"
import { Button } from "@renderer/components/ui/button"
import { Input } from "@renderer/components/ui/input"
import { Textarea } from "@renderer/components/ui/textarea"
import { Switch } from "@renderer/components/ui/switch"
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@renderer/components/ui/select"
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
  PersonalizationMemoryPreferences,
  PersonalizationManagementSnapshot,
} from "@shared/personalization-management-types"
import { errorMessage } from "./settings-error-message"

const toggles = [
  {
    key: "enabled",
    label: "项目长期记忆",
    description: "关闭后停止读取、提取和整理，已有内容保留。",
  },
  {
    key: "autoExtractEnabled",
    label: "自动提取记忆",
    description: "从成功任务提取长期信息，需开启长期记忆。",
  },
  {
    key: "sessionMemoryEnabled",
    label: "会话连续性记忆",
    description: "保存近期摘要，便于压缩后继续；独立于长期记忆。",
  },
  {
    key: "autoDreamEnabled",
    label: "自动整理记忆",
    description: "达到门槛后调用模型整理，会产生用量。",
  },
] as const

export function PersonalizationMemoryManagement() {
  const projects = useDesktopSessionStore((state) => state.projects)
  const [projectId, setProjectId] = useState<string | undefined>()
  const [snapshot, setSnapshot] = useState<PersonalizationManagementSnapshot | null>(null)
  const [hours, setHours] = useState("")
  const [sessions, setSessions] = useState("")
  const [error, setError] = useState("")
  const [feedback, setFeedback] = useState("")
  const [busy, setBusy] = useState(false)
  const [query, setQuery] = useState("")
  const [selected, setSelected] = useState<MemoryEntryRecord | null>(null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState("")
  const [confirmation, setConfirmation] = useState<{ text: string; apply(): Promise<void> } | null>(
    null
  )
  const request = useRef(0)
  const locked = useRef(false)
  function accept(value: PersonalizationManagementSnapshot) {
    setSnapshot(value)
    setHours(String(value.effective.autoDreamMinHours))
    setSessions(String(value.effective.autoDreamMinSessions))
  }
  const reload = useCallback(async () => {
    if (!window.desktop.personalizationManagement)
      throw new Error("记忆管理接口不可用，请重新连接后台服务。")
    const version = ++request.current
    const result = await window.desktop.personalizationManagement.snapshot({ projectId })
    if (version === request.current) accept(result)
  }, [projectId])
  useEffect(() => {
    const version = request.current + 1
    setSnapshot(null)
    setSelected(null)
    setEditing(false)
    setError("")
    void reload().catch((failure) => {
      if (request.current === version) setError(errorMessage(failure))
    })
    return () => {
      request.current++
    }
  }, [reload])
  async function run(operation: () => Promise<void>, message: string) {
    if (locked.current) return false
    locked.current = true
    setBusy(true)
    setError("")
    setFeedback("")
    try {
      await operation()
      setFeedback(message)
      return true
    } catch (failure) {
      setError(errorMessage(failure))
      return false
    } finally {
      locked.current = false
      setBusy(false)
    }
  }
  function configure(patch: Partial<PersonalizationMemoryPreferences>) {
    if (!snapshot) return
    void run(
      async () =>
        accept(
          await window.desktop.personalizationManagement.updateConfiguration({
            projectId,
            value: { ...snapshot.effective, ...patch },
            expected: snapshot.configured,
          })
        ),
      "已保存，后续任务生效。"
    )
  }
  const current = snapshot?.entries.find((entry) => entry.id === selected?.id)
  const changed = editing && selected && current && selected.revision !== current.revision
  const matches =
    snapshot?.entries.filter((entry) =>
      `${entry.content} ${entry.tags?.join(" ") ?? ""}`.toLowerCase().includes(query.toLowerCase())
    ) ?? []
  return (
    <section
      className="flex flex-col gap-5"
      aria-labelledby="personalization-memory"
      data-setting-id="personalization-memory"
    >
      <div className="flex items-center justify-between">
        <h2 id="personalization-memory" className="text-[15px] font-semibold">
          记忆与项目指令
        </h2>
        <Button
          variant="ghost"
          disabled={busy}
          onClick={() => void run(reload, "记忆已重新读取。")}
        >
          重新读取
        </Button>
      </div>
      <label className="flex items-center justify-between gap-3 text-sm">
        编辑范围
        <Select
          value={projectId ?? "global"}
          disabled={busy || editing}
          onValueChange={(value) => setProjectId(value && value !== "global" ? value : undefined)}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="global">用户默认</SelectItem>
            {projects.map((project) => (
              <SelectItem key={project.id} value={project.id}>
                {project.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {feedback && (
        <p role="status" className="text-xs text-muted-foreground">
          {feedback}
        </p>
      )}
      {!snapshot ? (
        <p role="status" className="text-sm text-muted-foreground">
          {error ? "记忆配置尚未读取。" : "正在读取记忆配置…"}
        </p>
      ) : (
        <>
          {toggles.map(({ key, label, description }) => (
            <label
              key={key}
              className="flex items-center justify-between gap-5 border-b border-border/60 py-3"
            >
              <span>
                <span className="block text-sm font-medium">{label}</span>
                <span className="mt-1 block text-xs text-muted-foreground">
                  {description} 当前来源：{snapshot.sources[key]}。
                </span>
              </span>
              <Switch
                aria-label={label}
                checked={snapshot.effective[key]}
                disabled={
                  busy ||
                  ((key === "autoExtractEnabled" || key === "autoDreamEnabled") &&
                    !snapshot.effective.enabled)
                }
                onCheckedChange={(value) => configure({ [key]: value })}
              />
            </label>
          ))}
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-2 text-sm">
              整理最短间隔（小时）
              <Input
                type="number"
                min="0.01"
                step="0.01"
                value={hours}
                disabled={busy}
                onChange={(event) => setHours(event.target.value)}
              />
            </label>
            <label className="space-y-2 text-sm">
              累计会话门槛
              <Input
                type="number"
                min="1"
                step="1"
                value={sessions}
                disabled={busy}
                onChange={(event) => setSessions(event.target.value)}
              />
            </label>
          </div>
          <Button
            className="self-start"
            disabled={
              busy ||
              (hours === String(snapshot.effective.autoDreamMinHours) &&
                sessions === String(snapshot.effective.autoDreamMinSessions))
            }
            onClick={() =>
              configure({
                autoDreamMinHours: Number(hours),
                autoDreamMinSessions: Number(sessions),
              })
            }
          >
            保存整理门槛
          </Button>
          {projectId && snapshot.configured && (
            <Button
              variant="ghost"
              className="self-start"
              disabled={busy}
              onClick={() =>
                void run(
                  async () =>
                    accept(
                      await window.desktop.personalizationManagement.updateConfiguration({
                        projectId,
                        value: null,
                        expected: snapshot.configured,
                      })
                    ),
                  "已移除项目覆盖，重新继承用户默认。"
                )
              }
            >
              移除项目覆盖
            </Button>
          )}
          <p className="text-xs text-muted-foreground">
            不影响 SOUL.md、USER.md 或环境信息。
          </p>
          {!projectId ? (
            <p className="text-sm text-muted-foreground">
              请选择项目。
            </p>
          ) : (
            <>
              <div className="space-y-2">
                <h3 className="text-sm font-medium">整理记录</h3>
                <p className="text-xs text-muted-foreground">
                  最近整理时间：
                  {snapshot.consolidation.lastConsolidatedAt
                    ? new Date(snapshot.consolidation.lastConsolidatedAt).toLocaleString()
                    : "尚无记录"}{" "}
                  ·{" "}
                  {(
                    {
                      unknown: "没有可读取的任务结果",
                      pending: "等待执行",
                      running: "正在整理",
                      completed: "已完成",
                      failed: "失败",
                      stopped: "已停止",
                    } as Record<string, string>
                  )[snapshot.consolidation.status] ?? snapshot.consolidation.status}
                  {snapshot.consolidation.taskId ? ` · 任务 ${snapshot.consolidation.taskId}` : ""}
                </p>
                {snapshot.consolidation.error && (
                  <p className="text-xs text-destructive">{snapshot.consolidation.error}</p>
                )}
              </div>
              <div className="space-y-2">
                <h3 className="text-sm font-medium">实际项目指令文件</h3>
                {snapshot.rules.length ? (
                  snapshot.rules.map((path) => (
                    <div key={path} className="flex items-center gap-3">
                      <span className="min-w-0 flex-1 font-mono text-xs break-all">{path}</span>
                      <Button
                        variant="ghost"
                        disabled={busy}
                        onClick={() =>
                          void run(
                            () =>
                              window.desktop.personalizationManagement.openRule({
                                projectId,
                                path,
                              }),
                            "已打开原指令文件。"
                          )
                        }
                      >
                        打开
                      </Button>
                    </div>
                  ))
                ) : (
                  <p className="text-xs text-muted-foreground">未找到当前项目加载的指令文件。</p>
                )}
              </div>
              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-medium">
                    项目长期记忆（{snapshot.entries.length} 条）
                  </h3>
                  <div className="flex gap-2">
                    <Button
                      variant="ghost"
                      disabled={busy}
                      onClick={() =>
                        void run(
                          () =>
                            window.desktop.personalizationManagement.openDirectory({ projectId }),
                          "已打开记忆目录。"
                        )
                      }
                    >
                      打开目录
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={
                        busy ||
                        !snapshot.managementAvailable ||
                        editing ||
                        !snapshot.entries.length ||
                        snapshot.entries.some((entry) => !entry.revision)
                      }
                      onClick={() =>
                        setConfirmation({
                          text: `清空所选项目 ${snapshot.projectPath} 的 ${snapshot.entries.length} 条记忆？只删除清单里的当前版本条目，不影响源码、其他项目或用户指令。`,
                          apply: async () => {
                            accept(
                              await window.desktop.personalizationManagement.clearEntries({
                                projectId,
                                expectedEntries: snapshot.entries.map((entry) => ({
                                  id: entry.id,
                                  revision: entry.revision!,
                                })),
                              })
                            )
                            setSelected(null)
                          },
                        })
                      }
                    >
                      清空项目记忆
                    </Button>
                  </div>
                </div>
                <p className="font-mono text-xs break-all text-muted-foreground">
                  {snapshot.directory}
                </p>
                {snapshot.entries.some((entry) => !entry.revision) && (
                  <p className="text-xs text-muted-foreground">
                    后台未提供条目版本，相关条目的编辑和清理不可用。
                  </p>
                )}
                {!snapshot.managementAvailable && (
                  <p className="text-xs text-muted-foreground">
                    后台未提供记忆管理能力，编辑和清理不可用。
                  </p>
                )}
                <Input
                  aria-label="搜索项目记忆"
                  placeholder="搜索内容或标签"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
                {matches.length ? (
                  matches.map((entry) => (
                    <div
                      key={entry.id}
                      className="flex items-start gap-3 border-b border-border/60 py-3"
                    >
                      <button
                        type="button"
                        disabled={busy || editing}
                        className="min-w-0 flex-1 text-left text-sm focus-visible:ring-2 focus-visible:ring-ring"
                        onClick={() => {
                          setSelected(entry)
                          setDraft(entry.content)
                        }}
                      >
                        <span className="line-clamp-2">{entry.content}</span>
                        <span className="mt-1 block text-xs text-muted-foreground">
                          {sourceLabel(entry)} · {new Date(entry.updatedAt).toLocaleString()}
                        </span>
                      </button>
                      <Button
                        variant="ghost"
                        disabled={
                          busy || editing || !snapshot.managementAvailable || !entry.revision
                        }
                        onClick={() =>
                          setConfirmation({
                            text: `删除这条项目记忆？${entry.content.slice(0, 100)}。删除前再次核对版本，只影响这一条。`,
                            apply: async () => {
                              accept(
                                await window.desktop.personalizationManagement.removeEntry({
                                  projectId,
                                  id: entry.id,
                                  expectedRevision: entry.revision!,
                                })
                              )
                              if (selected?.id === entry.id) setSelected(null)
                            },
                          })
                        }
                      >
                        删除
                      </Button>
                    </div>
                  ))
                ) : (
                  <p className="text-xs text-muted-foreground">
                    {snapshot.entries.length ? "没有匹配的记忆。" : "该项目没有长期记忆。"}
                  </p>
                )}
              </div>
              {selected && (
                <div className="space-y-3">
                  <h3 className="text-sm font-medium">
                    {editing ? "编辑记忆" : "查看记忆"} · {sourceLabel(selected)}
                  </h3>
                  <Textarea
                    aria-label="项目记忆内容"
                    readOnly={!editing}
                    disabled={busy}
                    className="min-h-40"
                    value={editing ? draft : (current?.content ?? selected.content)}
                    onChange={(event) => setDraft(event.target.value)}
                  />
                  {changed && (
                    <div className="space-y-2">
                      <p className="text-xs text-destructive">
                        记忆已被修改，草稿保留；请对比最新内容。
                      </p>
                      <Textarea aria-label="最新项目记忆内容" readOnly value={current.content} />
                      <Button variant="ghost" disabled={busy} onClick={() => setSelected(current)}>
                        保留草稿，采用最新版本
                      </Button>
                    </div>
                  )}
                  {editing && !current && (
                    <p className="text-xs text-destructive">
                      条目已删除，草稿仍保留；请取消后重新选择。
                    </p>
                  )}
                  <div className="flex gap-2">
                    {editing ? (
                      <>
                        <Button
                          disabled={
                            busy ||
                            !draft.trim() ||
                            !current ||
                            Boolean(changed) ||
                            draft === selected.content
                          }
                          onClick={() =>
                            void run(async () => {
                              accept(
                                await window.desktop.personalizationManagement.updateEntry({
                                  projectId,
                                  id: selected.id,
                                  content: draft,
                                  expectedRevision: selected.revision!,
                                })
                              )
                              setSelected(null)
                              setEditing(false)
                            }, "记忆已保存，后续请求生效。")
                          }
                        >
                          保存记忆
                        </Button>
                        <Button
                          variant="ghost"
                          disabled={busy}
                          onClick={() => {
                            setEditing(false)
                            setDraft(current?.content ?? selected.content)
                            setSelected(current ?? null)
                          }}
                        >
                          取消
                        </Button>
                      </>
                    ) : (
                      <Button
                        disabled={busy || !snapshot.managementAvailable || !current?.revision}
                        onClick={() => {
                          setSelected(current!)
                          setDraft(current!.content)
                          setEditing(true)
                        }}
                      >
                        编辑记忆
                      </Button>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
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
            <AlertDialogTitle>确认记忆操作</AlertDialogTitle>
            <AlertDialogDescription>{confirmation?.text}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const currentConfirmation = confirmation
                setConfirmation(null)
                if (currentConfirmation) void run(currentConfirmation.apply, "记忆操作已完成。")
              }}
            >
              确认
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}
function sourceLabel(entry: MemoryEntryRecord) {
  const label =
    entry.source?.type === "user_message"
      ? "用户消息"
      : entry.source?.type === "manual_remember"
        ? "手动记忆"
        : entry.source?.type === "manual_edit"
          ? "用户手动编辑"
          : "来源未记录"
  return entry.source?.sessionId ? `${label} · 会话 ${entry.source.sessionId}` : label
}

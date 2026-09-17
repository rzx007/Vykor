import { AnimatePresence, motion } from "motion/react"
import { CalendarClock, CircleAlert, X } from "lucide-react"
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react"

import { useAppearance } from "@renderer/components/appearance/appearance-provider"
import { ScrollArea } from "@renderer/components/ui/scroll-area"
import { Spinner } from "@renderer/components/ui/spinner"
import { cn } from "@renderer/lib/utils"
import type {
  CreateDesktopScheduledTaskInput,
  DesktopScheduledRun,
  DesktopScheduledStatus,
  DesktopScheduledTask,
  UpdateDesktopScheduledTaskInput,
} from "@shared/schedule-types"
import { DetailPanel } from "./scheduled-detail"
import { ScheduledHeader } from "./scheduled-header"
import { ScheduledTaskEditor } from "./scheduled-task-editor"
import { TaskRow } from "./task-row"
import type { ScheduledFilter, ScheduledPageProps } from "./types"
import { nextScheduleStatus } from "./utils"

const easeOutQuint = [0.22, 1, 0.36, 1] as const
const splitEase = "cubic-bezier(0.22, 1, 0.36, 1)"
const splitDuration = "0.42s"
const overviewColumns = "minmax(0, 1fr) minmax(0, 46rem) minmax(0, 1fr)"
const splitColumns = "minmax(0, 0fr) minmax(0, 44rem) minmax(0, 1fr)"

export function ScheduledPage({
  onStartConversation,
  onOpenConversation,
  onSessionListChanged,
}: ScheduledPageProps): React.JSX.Element {
  const { resolvedReducedMotion } = useAppearance()
  const [tasks, setTasks] = useState<DesktopScheduledTask[]>([])
  const [runs, setRuns] = useState<DesktopScheduledRun[]>([])
  const [status, setStatus] = useState<DesktopScheduledStatus | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [filter, setFilter] = useState<ScheduledFilter>("all")
  const [search, setSearch] = useState("")
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [runningTaskIds, setRunningTaskIds] = useState<Set<string>>(() => new Set())
  const [editorOpen, setEditorOpen] = useState(false)
  const [editorTask, setEditorTask] = useState<DesktopScheduledTask | null>(null)
  const deferredSearch = useDeferredValue(search.trim().toLocaleLowerCase())
  const refreshInitializedRef = useRef(false)
  const unreadCountRef = useRef(0)
  const notifiedRunIdsRef = useRef<Set<string>>(new Set())
  const knownRunSessionIdsRef = useRef<Set<string> | null>(null)
  const refreshRequestRef = useRef(0)
  const selectedIdRef = useRef(selectedId)
  const selectTask = useCallback((nextSelectedId: string | null): void => {
    selectedIdRef.current = nextSelectedId
    setSelectedId(nextSelectedId)
  }, [])

  const refresh = useCallback(async (): Promise<void> => {
    const requestId = ++refreshRequestRef.current
    const selectedTaskId = selectedId
    try {
      const previousUnread = unreadCountRef.current
      const initialized = refreshInitializedRef.current
      const [nextStatus, nextTasks, latestRuns, selectedRuns] = await Promise.all([
        window.desktop.schedules.status(),
        window.desktop.schedules.list(),
        window.desktop.schedules.listRuns({ limit: 50 }),
        selectedTaskId
          ? window.desktop.schedules.listRuns({ taskId: selectedTaskId, limit: 30 })
          : Promise.resolve(null),
      ])
      if (requestId !== refreshRequestRef.current || selectedTaskId !== selectedIdRef.current) return
      if (initialized && nextStatus.unread > previousUnread) {
        const unreadRuns = await window.desktop.schedules.listRuns({ unread: true, limit: 10 })
        await notifyUnreadScheduledRuns(
          unreadRuns,
          nextTasks,
          selectedTaskId,
          notifiedRunIdsRef.current
        )
      }
      const nextSessionIds = new Set(
        latestRuns.flatMap((run) => (run.sessionId ? [run.sessionId] : []))
      )
      const previousSessionIds = knownRunSessionIdsRef.current
      const sessionIdsChanged =
        (previousSessionIds === null && nextSessionIds.size > 0) ||
        (previousSessionIds !== null && !sameStringSet(previousSessionIds, nextSessionIds))
      let sessionListSynchronized = !sessionIdsChanged
      if (sessionIdsChanged) {
        try {
          await onSessionListChanged()
          sessionListSynchronized = true
        } catch {
          // Keep the previous snapshot so the next poll retries the narrow session-list refresh.
        }
      }
      if (requestId !== refreshRequestRef.current || selectedTaskId !== selectedIdRef.current) return
      if (sessionListSynchronized) knownRunSessionIdsRef.current = nextSessionIds
      unreadCountRef.current = nextStatus.unread
      refreshInitializedRef.current = true
      setStatus(nextStatus)
      setTasks(nextTasks)
      if (selectedRuns) {
        setRuns(selectedRuns.map((run) => (run.unread ? { ...run, unread: false } : run)))
      }
      setRunningTaskIds(
        new Set(
          latestRuns
            .filter((run) => run.status === "running" || run.status === "queued")
            .map((run) => run.taskId)
        )
      )
      if (
        selectedIdRef.current &&
        !nextTasks.some((task) => task.id === selectedIdRef.current)
      ) {
        selectTask(null)
      }
      setError(null)
    } catch (cause) {
      if (requestId === refreshRequestRef.current && selectedTaskId === selectedIdRef.current) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    } finally {
      setLoading(false)
    }
  }, [onSessionListChanged, selectTask, selectedId])

  useEffect(() => {
    const initialTimer = window.setTimeout(() => void refresh(), 0)
    const timer = window.setInterval(() => void refresh(), 20_000)
    return () => {
      window.clearTimeout(initialTimer)
      window.clearInterval(timer)
    }
  }, [refresh])

  useEffect(() => {
    if (!selectedId) return
    let disposed = false
    void window.desktop.schedules
      .listRuns({ taskId: selectedId, limit: 30 })
      .then(async (nextRuns) => {
        if (disposed) return
        setRuns(nextRuns.map((run) => (run.unread ? { ...run, unread: false } : run)))
        const unreadRuns = nextRuns.filter((run) => run.unread)
        if (unreadRuns.length === 0) return
        await Promise.all(
          unreadRuns.map((run) => window.desktop.schedules.setRunUnread(run.id, false))
        )
        const nextStatus = await window.desktop.schedules.status()
        if (!disposed) setStatus(nextStatus)
      })
      .catch(
        (cause) => !disposed && setError(cause instanceof Error ? cause.message : String(cause))
      )
    return () => {
      disposed = true
    }
  }, [selectedId])

  const selected = useMemo(
    () => tasks.find((task) => task.id === selectedId) ?? null,
    [selectedId, tasks]
  )
  const hasSelection = selected !== null

  const filterCounts = useMemo(
    () => ({
      all: tasks.length,
      active: tasks.filter((task) => task.status === "active").length,
      paused: tasks.filter((task) => task.status === "paused").length,
      completed: tasks.filter((task) => task.status === "completed").length,
    }),
    [tasks]
  )

  const visibleTasks = useMemo(() => {
    return tasks.filter((task) => {
      if (filter !== "all" && task.status !== filter) return false
      if (!deferredSearch) return true
      return `${task.name}\n${task.prompt}\n${task.projectPaths.join("\n")}`
        .toLocaleLowerCase()
        .includes(deferredSearch)
    })
  }, [deferredSearch, filter, tasks])

  const mutate = useCallback(
    async (key: string, operation: () => Promise<unknown>): Promise<void> => {
      setBusy(key)
      setError(null)
      try {
        await operation()
        await refresh()
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setBusy(null)
      }
    },
    [refresh]
  )

  const openCreateEditor = (): void => {
    setEditorTask(null)
    setEditorOpen(true)
  }

  const openEditEditor = (task: DesktopScheduledTask): void => {
    setEditorTask(task)
    setEditorOpen(true)
  }

  const saveTask = async (
    input: CreateDesktopScheduledTaskInput | UpdateDesktopScheduledTaskInput
  ): Promise<void> => {
    setBusy("save")
    try {
      const saved = editorTask
        ? await window.desktop.schedules.update(editorTask.id, input)
        : await window.desktop.schedules.create(input as CreateDesktopScheduledTaskInput)
      await refresh()
      selectTask(saved.id)
      setError(null)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      setError(message)
      throw new Error(message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="flex h-full min-h-0 w-full flex-col bg-background" aria-busy={loading}>
      {error ? (
        <div
          className="mx-8 mt-5 flex items-start justify-between gap-2 rounded-xl border border-destructive/20 bg-destructive/8 px-3 py-2.5 text-xs text-destructive"
          role="alert"
        >
          <div className="flex items-start gap-2">
            <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
            <span>{error}</span>
          </div>
          <button
            type="button"
            onClick={() => setError(null)}
            className="rounded p-0.5 text-destructive/70 hover:text-destructive"
            aria-label="关闭错误提示"
          >
            <X className="size-3.5" />
          </button>
        </div>
      ) : null}

      <div
        className="grid min-h-0 w-full flex-1 grid-rows-[minmax(0,1fr)] overflow-hidden"
        style={{
          gridTemplateColumns: hasSelection ? splitColumns : overviewColumns,
          transition: resolvedReducedMotion
            ? undefined
            : `grid-template-columns ${splitDuration} ${splitEase}`,
        }}
      >
        <div aria-hidden className="min-h-0 min-w-0 overflow-hidden" />

        <div
          className={cn(
            "flex min-h-0 min-w-0 flex-col overflow-hidden bg-background",
            hasSelection && "border-r border-border/70"
          )}
        >
          <div className={cn("flex min-h-0 flex-1 flex-col space-y-3", !hasSelection && "pt-14")}>
            <header className={cn("shrink-0", hasSelection ? "px-5 pt-5 pb-4" : "px-0")}>
              <ScheduledHeader
                compact={hasSelection}
                filter={filter}
                filterCounts={filterCounts}
                search={search}
                status={status}
                onFilterChange={setFilter}
                onSearchChange={setSearch}
                onRefresh={refresh}
                onCreateManual={openCreateEditor}
                onStartConversation={onStartConversation}
                loading={loading}
              />
            </header>

            <ScrollArea
              className="min-h-0 flex-1"
              viewportClassName={cn("min-h-0", hasSelection ? "px-5 pb-5" : "px-0 pb-10")}
              contentClassName={hasSelection ? "space-y-2" : "space-y-1"}
            >
              {loading ? (
                <div className="flex items-center gap-2 px-4 py-8 text-sm text-muted-foreground">
                  <Spinner className="size-4" />
                  正在加载任务…
                </div>
              ) : null}

              {!loading && visibleTasks.length === 0 ? (
                <div
                  className={cn(
                    "text-center",
                    hasSelection
                      ? "rounded-xl border border-dashed border-border/70 px-6 py-14"
                      : "px-6 py-16"
                  )}
                >
                  <CalendarClock className="mx-auto size-8 text-muted-foreground/45" />
                  <p className="mt-3 text-sm font-medium text-foreground">没有匹配的任务</p>
                  <p className="mx-auto mt-1 max-w-64 text-xs leading-5 text-muted-foreground">
                    调整筛选条件，或在 Agent 对话里新建一个任务。
                  </p>
                </div>
              ) : null}

              {visibleTasks.map((task) => {
                const active = task.id === selectedId
                return (
                  <TaskRow
                    key={task.id}
                    task={task}
                    active={active}
                    compact={hasSelection}
                    running={runningTaskIds.has(task.id)}
                    busy={busy !== null}
                    onSelect={() => selectTask(task.id)}
                    onRunNow={() =>
                      void mutate("run", () => window.desktop.schedules.runNow(task.id))
                    }
                    onEdit={() => openEditEditor(task)}
                    onToggle={() => {
                      if (task.status === "completed") return
                      void mutate("toggle", () =>
                        window.desktop.schedules.update(task.id, {
                          status: nextScheduleStatus(task),
                        })
                      )
                    }}
                    onDelete={() =>
                      void mutate("delete", () => window.desktop.schedules.remove(task.id))
                    }
                  />
                )
              })}
            </ScrollArea>
          </div>
        </div>

        <div className="flex min-h-0 min-w-0 flex-col overflow-hidden bg-background">
          <AnimatePresence initial={false}>
            {selected ? (
              <motion.section
                key="scheduled-detail"
                initial={resolvedReducedMotion ? { opacity: 1 } : { opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={resolvedReducedMotion ? { opacity: 1 } : { opacity: 0 }}
                transition={{
                  duration: resolvedReducedMotion ? 0 : 0.32,
                  ease: easeOutQuint,
                }}
                className="flex min-h-0 min-w-0 flex-1 flex-col"
              >
                <ScrollArea
                  className="min-h-0 flex-1"
                  viewportClassName="px-5 pt-4 pb-8"
                  contentClassName="pb-4"
                >
                  <DetailPanel
                    task={selected}
                    runs={runs}
                    busy={busy}
                    onBack={() => selectTask(null)}
                    onRunNow={() =>
                      void mutate(`run:${selected.id}`, () =>
                        window.desktop.schedules.runNow(selected.id)
                      )
                    }
                    onEdit={() => openEditEditor(selected)}
                    onToggle={() => {
                      if (selected.status === "completed") return
                      void mutate("toggle", () =>
                        window.desktop.schedules.update(selected.id, {
                          status: nextScheduleStatus(selected),
                        })
                      )
                    }}
                    onDelete={() =>
                      void mutate("delete", () => window.desktop.schedules.remove(selected.id))
                    }
                    onOpenSession={(sessionId) => {
                      setError(null)
                      void onOpenConversation(sessionId).catch((cause) => {
                        setError(cause instanceof Error ? cause.message : String(cause))
                        void refresh()
                      })
                    }}
                  />
                </ScrollArea>
              </motion.section>
            ) : null}
          </AnimatePresence>
        </div>
      </div>
      {editorOpen ? (
        <ScheduledTaskEditor
          open
          task={editorTask}
          busy={busy === "save"}
          onOpenChange={(open) => {
            setEditorOpen(open)
            if (!open) setEditorTask(null)
          }}
          onSave={saveTask}
        />
      ) : null}
    </section>
  )
}

function sameStringSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value))
}

async function notifyUnreadScheduledRuns(
  runs: readonly DesktopScheduledRun[],
  tasks: readonly DesktopScheduledTask[],
  selectedTaskId: string | null,
  notifiedRunIds: Set<string>
): Promise<void> {
  const mode = await readNotificationMode()
  if (mode === "never") return

  const taskNames = new Map(tasks.map((task) => [task.id, task.name]))
  for (const run of runs) {
    if (run.taskId === selectedTaskId || notifiedRunIds.has(run.id)) continue
    notifiedRunIds.add(run.id)
    const taskName = taskNames.get(run.taskId)?.trim() || "已安排任务"
    await window.desktop.tray.notify({
      title: scheduledRunNotificationTitle(run),
      body: `${taskName} 有新的运行结果。`,
      ...(mode === "always" ? { showWhenFocused: true } : {}),
    })
  }
}

async function readNotificationMode(): Promise<"never" | "when_unfocused" | "always"> {
  try {
    return (await window.desktop.settings.snapshot()).notificationMode
  } catch {
    return "when_unfocused"
  }
}

function scheduledRunNotificationTitle(run: DesktopScheduledRun): string {
  if (run.status === "succeeded") return "已安排任务完成"
  if (run.status === "needs_attention") return "已安排任务需要处理"
  if (run.status === "failed" || run.status === "interrupted") return "已安排任务失败"
  return "已安排任务有新结果"
}

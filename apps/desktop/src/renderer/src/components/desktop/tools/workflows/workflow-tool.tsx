import { useEffect, useMemo, useRef, useState } from "react"
import { useDesktopSessionStore } from "@renderer/stores/desktop-session"
import {
  CircleStop,
  Crosshair,
  GitBranch,
  RefreshCw,
  LayoutList,
  Activity,
  MessageCircle,
} from "lucide-react"
import { Button } from "@renderer/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@renderer/components/motion/tabs"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@renderer/components/ui/select"
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
} from "@renderer/components/ui/alert-dialog"
import { toast } from "@renderer/lib/toast"
import type { DesktopSessionTask } from "@shared/session-types"
import type { DesktopWorkflowRun } from "@shared/workflow-types"
import { useWorkflows } from "./workflow-provider"
import {
  workflowCounts,
  workflowRepairDraft,
  workflowStatus,
  workflowTitle,
  workflowProgress,
} from "./workflow-model"
import { WorkflowGraph } from "./workflow-graph"
import { WorkflowDetails, eventLabel } from "./workflow-details"
import { WorkflowOutputFiles } from "./workflow-output"
import { WorkflowTaskRows } from "./workflow-task-rows"

type Props = {
  active: boolean
  agentTasks?: DesktopSessionTask[]
  onOpenFile(path: string): void
  onOpenAgents(taskId: string): void
  onOpenReview(path?: string, rootPath?: string): void
}

export function WorkflowTool(props: Props) {
  const context = useWorkflows()
  if (!props.active) return null
  const runs = context?.snapshot?.runs ?? []
  const selected = context?.selection.runId
    ? runs.find((run) => run.id === context.selection.runId)
    : (runs.find((run) => run.status === "running") ?? runs[0])
  return (
    <section className="flex size-full min-h-0 flex-col bg-conversation" aria-label="编排">
      <div className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
        <GitBranch
          aria-hidden="true"
          className="size-4 shrink-0 text-muted-foreground"
          strokeWidth={1.75}
        />
        {runs.length ? (
          <Select
            value={selected?.id ?? null}
            onValueChange={(value) => {
              if (value) context?.select(value)
            }}
          >
            <SelectTrigger aria-label="选择编排运行" className="max-w-sm min-w-0 flex-1">
              <SelectValue>
                {selected
                  ? `${workflowTitle(selected)} · ${new Date(selected.startedAt).toLocaleTimeString()}`
                  : "选择其他编排"}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {runs.map((run) => (
                <SelectItem key={run.id} value={run.id}>
                  {workflowTitle(run)} · {workflowStatus(run)} ·{" "}
                  {new Date(run.startedAt).toLocaleString()}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <span className="flex-1 text-sm font-medium">编排</span>
        )}
        <Button
          variant="ghost"
          shape="circle"
          size="icon"
          className="ml-auto"
          aria-label="返回来源消息"
          title="返回来源消息"
          disabled={!selected}
          onClick={() => {
            if (selected)
              window.dispatchEvent(
                new CustomEvent("desktop:workflow-source", {
                  detail: { sessionId: selected.sessionId, runId: selected.id },
                })
              )
          }}
        >
          <MessageCircle />
        </Button>
        <Button
          variant="ghost"
          shape="circle"
          size="icon"
          aria-label="刷新编排"
          disabled={context?.loading}
          onClick={() => {
            void context?.refresh()
          }}
        >
          <RefreshCw />
        </Button>
      </div>
      {context?.syncStatus === "reconnecting" ? (
        <p role="status" className="border-b px-4 py-2 text-xs text-muted-foreground">
          正在重新连接，显示上次读取的状态。
        </p>
      ) : null}
      {context?.error ? (
        <p role="alert" className="border-b px-4 py-2 text-xs text-destructive">
          状态读取失败：{context.error}。可刷新重试。
        </p>
      ) : null}
      {context?.snapshot?.errors.length ? (
        <p role="alert" className="border-b px-4 py-2 text-xs text-destructive">
          部分编排详情读取失败，可刷新重试。
        </p>
      ) : null}
      <div className="min-h-0 flex-1 scrollbar-thin overflow-auto">
        {selected ? (
          <WorkflowRunView key={selected.id} {...props} run={selected} />
        ) : (
          <div className="px-5 py-8 text-sm text-muted-foreground">
            {context?.loading
              ? "正在读取编排…"
              : context?.selection.runId
                ? "未能读取所选编排。请刷新重试，或从上方选择其他运行。"
                : "当前会话还没有编排。Agent 使用 Workflow 后，可在这里查看任务关系和执行状态。"}
          </div>
        )}
        {context?.snapshot?.hasMore ? (
          <p className="px-4 py-3 text-xs text-muted-foreground">显示最近 50 次编排。</p>
        ) : null}
      </div>
    </section>
  )
}

function WorkflowRunView({ run: sourceRun, ...props }: Props & { run: DesktopWorkflowRun }) {
  const context = useWorkflows()!
  const runView = useRef<HTMLDivElement>(null)
  const activities = useDesktopSessionStore((state) => state.activity.sessions)
  const run = useMemo(
    () => ({
      ...sourceRun,
      tasks: sourceRun.tasks.map((task) => {
        const agent = props.agentTasks?.find((agent) => agent.id === task.workerTaskId)
        return {
          ...task,
          needsInput: Boolean(
            agent?.childSessionId &&
            activities[agent.childSessionId]?.executionState === "needs_input"
          ),
        }
      }),
    }),
    [sourceRun, props.agentTasks, activities]
  )
  const [view, setView] = useState(context.selection.taskId ? "graph" : "overview")
  useEffect(() => {
    if (context.selection.focus) setView(context.selection.taskId ? "graph" : "overview")
  }, [context.selection.focus, context.selection.taskId])
  const [stopOpen, setStopOpen] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const counts = workflowCounts(run)
  const failed = run.tasks.filter((task) => task.status === "failed")
  const unconfirmed = run.tasks.find((task) => task.cleanupUnconfirmed)
  const selected = run.tasks.find((task) => task.id === context.selection.taskId)
  const needsInput = run.tasks.find((task) => task.status === "running" && task.needsInput)
  const running = run.tasks.filter((task) => task.status === "running")
  const attention = unconfirmed ?? needsInput ?? failed[0]
  const current = attention ?? running[0]
  const headline = unconfirmed
    ? "有任务未确认停止"
    : needsInput
      ? "等待你处理"
      : failed.length
        ? "有任务需要处理"
        : run.needsReconciliation
          ? "有改动需要检查"
          : run.status === "completed"
            ? "编排已完成"
            : run.status === "running"
              ? "正在执行"
              : workflowStatus(run)
  const duration =
    run.finishedAt === undefined
      ? null
      : Math.max(0, Math.round((run.finishedAt - run.startedAt) / 1000))
  const select = (id: string, focus = false) => {
    context.select(run.id, id, focus)
    if (focus) setView("graph")
  }
  const repair = () => {
    window.dispatchEvent(
      new CustomEvent("desktop:add-to-composer", {
        detail: {
          sessionId: run.sessionId,
          text: workflowRepairDraft(
            run,
            selected && (selected.status === "failed" || selected.cleanupUnconfirmed)
              ? selected
              : undefined
          ),
        },
      })
    )
    toast.info("已加入聊天草稿", "补充处理要求后发送给 Agent。")
  }
  const stop = async () => {
    setStopping(true)
    setError(null)
    try {
      await context.cancel(run.jobId)
      setStopOpen(false)
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
    } finally {
      setStopping(false)
    }
  }
  return (
    <div ref={runView} className="mx-auto w-full max-w-4xl px-4 pb-6 sm:px-6">
      <section aria-label="当前重点" className="pt-6 pb-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold tracking-tight" aria-live="polite">
            {headline}
          </h2>
          {run.canCancel ? (
            <Button variant="ghost" shape="pill" size="sm" onClick={() => setStopOpen(true)}>
              <CircleStop data-icon="inline-start" />
              停止编排
            </Button>
          ) : null}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          {workflowProgress(run)}
          {duration !== null
            ? ` · 用时 ${duration >= 60 ? `${Math.floor(duration / 60)} 分 ` : ""}${duration % 60} 秒`
            : ""}
        </p>
        {current ? (
          <div className="mt-4 space-y-1.5">
            <p className="text-sm font-medium break-words">{current.title}</p>
            {attention ? (
              <p className="line-clamp-3 text-sm break-words text-muted-foreground">
                {unconfirmed
                  ? "重新执行前，请先检查仍在运行的工作与文件改动。"
                  : needsInput
                    ? "子 Agent 正在等待你的输入或确认。"
                    : (current.error ?? current.summary ?? "执行失败，请查看任务详情。")}
              </p>
            ) : running.length > 1 ? (
              <p className="text-xs text-muted-foreground">
                另有 {running.length - 1} 项任务并行执行，可在下方查看。
              </p>
            ) : null}
          </div>
        ) : null}
        <div className="mt-2 flex flex-wrap gap-1">
          {unconfirmed ? (
            <Button
              variant="default"
              shape="pill"
              size="sm"
              onClick={() => select(unconfirmed.id, true)}
            >
              检查未确认停止的任务
            </Button>
          ) : null}
          {failed.length && !unconfirmed && !needsInput ? (
            <Button
              variant="default"
              shape="pill"
              size="sm"
              onClick={() =>
                select(
                  failed[(failed.findIndex((task) => task.id === selected?.id) + 1) % failed.length]
                    .id,
                  true
                )
              }
            >
              <Crosshair data-icon="inline-start" />
              定位失败 · {failed.length}
            </Button>
          ) : null}
          {needsInput ? (
            <Button
              variant="default"
              shape="pill"
              size="sm"
              onClick={() => select(needsInput.id, true)}
            >
              查看待处理任务
            </Button>
          ) : null}
          {counts.running && !attention ? (
            <Button
              variant="ghost"
              shape="pill"
              size="sm"
              onClick={() => select(run.tasks.find((task) => task.status === "running")!.id, true)}
            >
              定位运行中
            </Button>
          ) : null}
          {failed.length || unconfirmed || run.needsReconciliation ? (
            <Button variant="ghost" shape="pill" size="sm" onClick={repair}>
              让 Agent 处理
            </Button>
          ) : null}
        </div>
        {run.needsReconciliation ? (
          <div role="status" className="mt-3 text-sm">
            <p className="font-medium">有改动需要检查和合并</p>
            {run.reconciliationIssues.map((issue, index) => (
              <p key={index} className="mt-1 text-xs text-muted-foreground">
                {issue}
              </p>
            ))}
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="mt-2 text-xs text-destructive">
            {error}
          </p>
        ) : null}
      </section>
      {run.detailsAvailable ? (
        <>
          <Tabs value={view} onValueChange={setView} variant="pill" icons="selected">
            <TabsList aria-label="编排视图" wrapperClassName="mb-2">
              <TabsTrigger
                value="overview"
                aria-label="概览"
                icon={<LayoutList className="size-4" strokeWidth={1.75} />}
              >
                概览
              </TabsTrigger>
              <TabsTrigger
                value="graph"
                aria-label="任务图"
                icon={<GitBranch className="size-4" strokeWidth={1.75} />}
              >
                任务图
              </TabsTrigger>
              <TabsTrigger
                value="events"
                aria-label="事件"
                icon={<Activity className="size-4" strokeWidth={1.75} />}
              >
                事件
              </TabsTrigger>
            </TabsList>
            <TabsContent value="overview" className="mt-0 space-y-7 pt-4">
              <WorkflowOutputFiles tasks={run.tasks} onOpenFile={props.onOpenFile} />
              <WorkflowTaskRows
                run={run}
                onSelect={(id) => select(id, true)}
                onOpenFile={props.onOpenFile}
                onOpenReview={props.onOpenReview}
              />
            </TabsContent>
            <TabsContent value="graph" className="mt-0">
              <WorkflowGraph
                run={run}
                selectedId={selected?.id}
                focus={view === "graph" ? context.selection.focus : 0}
                onSelect={select}
              />
            </TabsContent>
            <TabsContent value="events" className="mt-0 py-4">
              {run.events.length ? (
                <ol className="space-y-3">
                  {run.events.map((event, index) => (
                    <li key={`${event.timestamp}:${index}`} className="flex gap-3 text-xs">
                      <time className="shrink-0 text-muted-foreground tabular-nums">
                        {new Date(event.timestamp).toLocaleTimeString()}
                      </time>
                      <div className="min-w-0">
                        <p>
                          {eventLabel(event.type)}
                          {event.taskId
                            ? ` · ${run.tasks.find((task) => task.id === event.taskId)?.title ?? event.taskId}`
                            : ""}
                        </p>
                        {event.summary ? (
                          <p className="mt-1 break-words whitespace-pre-wrap text-muted-foreground">
                            {event.summary}
                          </p>
                        ) : null}
                        {event.taskId ? (
                          <Button
                            variant="ghost"
                            shape="pill"
                            size="sm"
                            onClick={() => select(event.taskId!, true)}
                          >
                            定位任务
                          </Button>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="text-xs text-muted-foreground">尚无编排事件。</p>
              )}
              {run.eventsTruncated ? (
                <p className="mt-3 text-xs text-muted-foreground">显示最近 200 条事件。</p>
              ) : null}
            </TabsContent>
          </Tabs>
          {selected && view === "graph" ? (
            <WorkflowDetails
              key={selected.id}
              {...props}
              run={run}
              task={selected}
              onSelect={(id) => select(id, true)}
              onClose={() => {
                const node = [
                  ...(runView.current?.querySelectorAll<HTMLButtonElement>(
                    "[data-workflow-node]"
                  ) ?? []),
                ].find((node) => node.dataset.workflowNode === selected.id)
                context.select(run.id)
                node?.focus({ preventScroll: true })
              }}
            />
          ) : null}
        </>
      ) : (
        <p className="px-4 py-4 text-sm text-muted-foreground">
          无法读取任务图和节点详情。刷新后重试，原始工具调用仍保留在聊天中。
        </p>
      )}
      <AlertDialog
        open={stopOpen}
        onOpenChange={(value) => {
          if (!stopping) setStopOpen(value)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>停止这次编排？</AlertDialogTitle>
            <AlertDialogDescription>
              停止正在运行的节点，并跳过尚未开始的任务。已经完成的结果和文件改动会保留。
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={stopping}>继续执行</AlertDialogCancel>
            <Button
              variant="destructive"
              shape="pill"
              disabled={stopping}
              onClick={() => {
                void stop()
              }}
            >
              {stopping ? "正在停止…" : "停止编排"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

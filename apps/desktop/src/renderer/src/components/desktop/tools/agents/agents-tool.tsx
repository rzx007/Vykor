import { AlertCircle, ArrowLeft, Bot, CircleCheck } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"

import { ConversationTranscript } from "@renderer/components/desktop/conversation-page/transcript/transcript"
import { Alert, AlertDescription, AlertTitle } from "@renderer/components/ui/alert"
import { Badge } from "@renderer/components/ui/badge"
import { Button } from "@renderer/components/ui/button"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@renderer/components/ui/empty"
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@renderer/components/ui/item"
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@renderer/components/ui/message-scroller"
import { Spinner } from "@renderer/components/ui/spinner"
import { cn } from "@renderer/lib/utils"
import { useDesktopSessionStore } from "@renderer/stores/desktop-session"
import type { DesktopSessionTask, DesktopSessionView } from "@shared/session-types"
import { groupAgentTasks, matchesAgentSessionUpdate } from "./agent-task-model"

const detailsSubscriptionId = "agents:details"
const emptyTasks: DesktopSessionTask[] = []

export function AgentsTool({
  active,
  onOpenFile,
  canOpenReview,
  onOpenReview,
  onOpenTerminal,
}: {
  active: boolean
  onOpenFile: (path: string, line?: number) => void
  canOpenReview: boolean
  onOpenReview: (path?: string) => void
  onOpenTerminal: (terminalId: string) => void
}): React.JSX.Element {
  const tasks = useDesktopSessionStore((state) => state.sessionView?.tasks ?? emptyTasks)
  const groups = useMemo(() => groupAgentTasks(tasks), [tasks])
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [childView, setChildView] = useState<DesktopSessionView | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const requestVersionRef = useRef(0)
  const selectedChildSessionIdRef = useRef<string | null>(null)
  const selectedTask = tasks.find((task) => task.id === selectedTaskId)

  useEffect(() => {
    return window.desktop.sessions.onAuxUpdated((update) => {
      if (
        !matchesAgentSessionUpdate(detailsSubscriptionId, selectedChildSessionIdRef.current, update)
      )
        return
      setChildView(update.view)
    })
  }, [])

  useEffect(() => {
    return () => {
      void window.desktop.sessions.closeAux({ subscriptionId: detailsSubscriptionId })
    }
  }, [])

  const openTask = async (task: DesktopSessionTask): Promise<void> => {
    if (!task.childSessionId) return
    const requestVersion = requestVersionRef.current + 1
    requestVersionRef.current = requestVersion
    selectedChildSessionIdRef.current = task.childSessionId
    setSelectedTaskId(task.id)
    setChildView(null)
    setLoading(true)
    setError(null)
    try {
      const view = await window.desktop.sessions.openAux({
        subscriptionId: detailsSubscriptionId,
        sessionId: task.childSessionId,
      })
      if (requestVersionRef.current === requestVersion) setChildView(view)
    } catch (cause) {
      if (requestVersionRef.current === requestVersion) setError(errorMessage(cause))
    } finally {
      if (requestVersionRef.current === requestVersion) setLoading(false)
    }
  }

  const showList = (): void => {
    requestVersionRef.current += 1
    selectedChildSessionIdRef.current = null
    setSelectedTaskId(null)
    setChildView(null)
    setLoading(false)
    setError(null)
    void window.desktop.sessions.closeAux({ subscriptionId: detailsSubscriptionId })
  }

  return (
    <section
      aria-label="子智能体"
      className={cn("size-full min-h-0 bg-conversation", active ? "flex flex-col" : "hidden")}
    >
      {selectedTaskId ? (
        <AgentDetails
          task={selectedTask}
          view={childView}
          loading={loading}
          error={error}
          onBack={showList}
          onOpenFile={onOpenFile}
          canOpenReview={canOpenReview}
          onOpenReview={onOpenReview}
          onOpenTerminal={onOpenTerminal}
        />
      ) : (
        <AgentTaskList active={groups.active} completed={groups.completed} onOpen={openTask} />
      )}
    </section>
  )
}

function AgentTaskList({
  active,
  completed,
  onOpen,
}: {
  active: DesktopSessionTask[]
  completed: DesktopSessionTask[]
  onOpen: (task: DesktopSessionTask) => void
}): React.JSX.Element {
  if (active.length === 0 && completed.length === 0) {
    return (
      <Empty className="border-0">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Bot />
          </EmptyMedia>
          <EmptyTitle>还没有子智能体</EmptyTitle>
          <EmptyDescription>
            当前对话派发子智能体后，它们的进度和完整消息会显示在这里。
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 scrollbar-thin flex-col gap-6 overflow-y-auto px-4 py-5">
      <AgentTaskGroup title="进行中" tasks={active} active onOpen={onOpen} />
      <AgentTaskGroup title="已完成" tasks={completed} onOpen={onOpen} />
    </div>
  )
}

function AgentTaskGroup({
  title,
  tasks,
  active = false,
  onOpen,
}: {
  title: string
  tasks: DesktopSessionTask[]
  active?: boolean
  onOpen: (task: DesktopSessionTask) => void
}): React.JSX.Element {
  return (
    <section className="flex flex-col gap-2" aria-label={title}>
      <h2 className="px-1 text-xs font-medium text-muted-foreground">
        {title} · {tasks.length}
      </h2>
      {tasks.length === 0 ? (
        <p className="px-1 py-2 text-sm text-muted-foreground">
          {active ? "没有正在运行的子智能体" : "没有已完成的子智能体"}
        </p>
      ) : (
        <ItemGroup className="gap-2">
          {tasks.map((task) => (
            <AgentTaskItem key={task.id} task={task} onOpen={onOpen} />
          ))}
        </ItemGroup>
      )}
    </section>
  )
}

function AgentTaskItem({
  task,
  onOpen,
}: {
  task: DesktopSessionTask
  onOpen: (task: DesktopSessionTask) => void
}): React.JSX.Element {
  const running = task.status === "pending" || task.status === "running"
  const failed = task.status === "failed" || task.status === "interrupted"
  return (
    <Item
      variant="muted"
      size="sm"
      render={<button type="button" onClick={() => onOpen(task)} />}
      className="cursor-pointer flex-nowrap text-left hover:bg-muted"
    >
      <ItemMedia variant="icon" className="text-muted-foreground">
        {running ? <Spinner /> : <CircleCheck />}
      </ItemMedia>
      <ItemContent className="min-w-0">
        <ItemTitle className="max-w-full truncate">{task.description}</ItemTitle>
        <ItemDescription className="line-clamp-1">
          {task.error ?? task.output ?? taskStatusLabel(task.status)}
        </ItemDescription>
      </ItemContent>
      <ItemActions>
        <Badge variant={failed ? "destructive" : running ? "secondary" : "outline"}>
          {taskStatusLabel(task.status)}
        </Badge>
      </ItemActions>
    </Item>
  )
}

function AgentDetails({
  task,
  view,
  loading,
  error,
  onBack,
  onOpenFile,
  canOpenReview,
  onOpenReview,
  onOpenTerminal,
}: {
  task?: DesktopSessionTask
  view: DesktopSessionView | null
  loading: boolean
  error: string | null
  onBack: () => void
  onOpenFile: (path: string, line?: number) => void
  canOpenReview: boolean
  onOpenReview: (path?: string) => void
  onOpenTerminal: (terminalId: string) => void
}): React.JSX.Element {
  const running = Boolean(
    view?.runs.some((run) => run.status === "pending" || run.status === "running")
  )
  const failed = task?.status === "failed" || task?.status === "interrupted"
  return (
    <>
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="返回子智能体列表"
          onClick={onBack}
        >
          <ArrowLeft />
        </Button>
        <Bot className="size-4 shrink-0 text-muted-foreground" />
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium">
          {task?.description ?? view?.session.title ?? "子智能体"}
        </h2>
        {task ? (
          <Badge variant={failed ? "destructive" : "outline"}>{taskStatusLabel(task.status)}</Badge>
        ) : null}
      </header>
      {task?.error ? (
        <div className="px-4 pt-4">
          <Alert variant="destructive">
            <AlertCircle />
            <AlertTitle>子智能体任务失败</AlertTitle>
            <AlertDescription>{task.error}</AlertDescription>
          </Alert>
        </div>
      ) : null}
      {loading ? (
        <div
          className="flex min-h-0 flex-1 items-center justify-center gap-2 text-sm text-muted-foreground"
          aria-live="polite"
        >
          <Spinner />
          正在加载消息
        </div>
      ) : error ? (
        <div className="p-4">
          <Alert variant="destructive">
            <AlertCircle />
            <AlertTitle>无法加载子智能体消息</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        </div>
      ) : view ? (
        <MessageScrollerProvider
          key={view.session.id}
          autoScroll
          defaultScrollPosition="last-anchor"
        >
          <MessageScroller className="min-h-0 flex-1">
            <MessageScrollerViewport>
              <MessageScrollerContent className="min-h-full gap-6 px-5 py-5">
                <ConversationTranscript
                  messages={view.messages}
                  parts={view.parts}
                  runs={view.runs}
                  running={running}
                  canEditLastUserMessage={false}
                  onEditLastUserMessage={() => {}}
                  onCopyAssistantMessage={(content) =>
                    void window.desktop.clipboard.writeText(content)
                  }
                  showReasoning={false}
                  onOpenFile={onOpenFile}
                  canOpenReview={canOpenReview}
                  onOpenReview={onOpenReview}
                  onOpenTerminal={onOpenTerminal}
                />
              </MessageScrollerContent>
            </MessageScrollerViewport>
            <MessageScrollerButton />
          </MessageScroller>
        </MessageScrollerProvider>
      ) : null}
    </>
  )
}

function taskStatusLabel(status: DesktopSessionTask["status"]): string {
  return {
    pending: "等待中",
    running: "运行中",
    completed: "已完成",
    failed: "失败",
    stopped: "已停止",
    interrupted: "已中断",
  }[status]
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

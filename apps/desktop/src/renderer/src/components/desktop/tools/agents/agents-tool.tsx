import { AlertCircle, ArrowLeft, Bot, CircleCheck } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

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
import { applySessionPartDeltas } from "@renderer/stores/desktop-session/session-view-state"
import { createSessionUpdateDeliveryAcknowledger } from "@renderer/stores/desktop-session/session-update-delivery"
import type { DesktopSessionTask, DesktopSessionView } from "@shared/session-types"
import {
  agentTaskStatusLabel,
  groupAgentTasks,
  matchesAgentSessionUpdate,
} from "./agent-task-model"

const detailsSubscriptionId = "agents:details"
const emptyTasks: DesktopSessionTask[] = []

export function AgentsTool({
  active,
  openRequest,
  onOpenFile,
  canOpenReview,
  onOpenReview,
  onOpenTerminal,
}: {
  active: boolean
  openRequest?: { id: number; taskId?: string } | null
  onOpenFile: (path: string, line?: number) => void
  canOpenReview: boolean
  onOpenReview: (path?: string) => void
  onOpenTerminal: (terminalId: string) => void
}): React.JSX.Element {
  const tasks = useDesktopSessionStore((state) =>
    active ? (state.sessionView?.tasks ?? emptyTasks) : emptyTasks
  )
  const groups = useMemo(() => groupAgentTasks(tasks), [tasks])
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const selectedTask = tasks.find((task) => task.id === selectedTaskId)
  const handledOpenRequestRef = useRef<number | null>(null)

  const openTask = useCallback((task: DesktopSessionTask): void => {
    if (!task.childSessionId) return
    setSelectedTaskId(task.id)
  }, [])

  useEffect(() => {
    if (!active || !openRequest?.taskId || handledOpenRequestRef.current === openRequest.id) return
    const task = tasks.find((item) => item.id === openRequest.taskId && item.childSessionId)
    if (!task) return
    const timer = window.setTimeout(() => {
      handledOpenRequestRef.current = openRequest.id
      void openTask(task)
    }, 0)
    return () => window.clearTimeout(timer)
  }, [active, openRequest, tasks, openTask])

  const showList = (): void => {
    setSelectedTaskId(null)
  }

  return (
    <section
      aria-label="子智能体"
      className={cn("size-full min-h-0 bg-conversation", active ? "flex flex-col" : "hidden")}
    >
      {active ? (
        selectedTaskId ? (
          <AgentDetails
            key={selectedTask?.childSessionId ?? selectedTaskId}
            task={selectedTask}
            onBack={showList}
            onOpenFile={onOpenFile}
            canOpenReview={canOpenReview}
            onOpenReview={onOpenReview}
            onOpenTerminal={onOpenTerminal}
          />
        ) : (
          <AgentTaskList active={groups.active} completed={groups.completed} onOpen={openTask} />
        )
      ) : null}
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
          {task.error ?? task.output ?? agentTaskStatusLabel(task.status)}
        </ItemDescription>
      </ItemContent>
      <ItemActions>
        <Badge variant={failed ? "destructive" : running ? "secondary" : "outline"}>
          {agentTaskStatusLabel(task.status)}
        </Badge>
      </ItemActions>
    </Item>
  )
}

function AgentDetails({
  task,
  onBack,
  onOpenFile,
  canOpenReview,
  onOpenReview,
  onOpenTerminal,
}: {
  task?: DesktopSessionTask
  onBack: () => void
  onOpenFile: (path: string, line?: number) => void
  canOpenReview: boolean
  onOpenReview: (path?: string) => void
  onOpenTerminal: (terminalId: string) => void
}): React.JSX.Element {
  const childSessionId = task?.childSessionId
  const [view, setView] = useState<DesktopSessionView | null>(null)
  const viewRef = useRef<DesktopSessionView | null>(null)
  const [loading, setLoading] = useState(Boolean(childSessionId))
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!childSessionId) return
    let disposed = false
    viewRef.current = null
    const acknowledger = createSessionUpdateDeliveryAcknowledger(window.desktop.sessions)
    let currentGeneration = 0
    const unsubscribe = window.desktop.sessions.onAuxUpdated((update) => {
      if (disposed || update.subscriptionId !== detailsSubscriptionId) return
      const delivery = update.update
      if (!matchesAgentSessionUpdate(detailsSubscriptionId, childSessionId, update)) {
        acknowledger.acknowledge(
          { ...delivery, subscriptionId: update.subscriptionId },
          "resync-required"
        )
        return
      }
      if (delivery.generation < currentGeneration) return
      if (delivery.kind === "snapshot") {
        currentGeneration = delivery.generation
        viewRef.current = delivery.view
        setView(delivery.view)
        acknowledger.acknowledge(delivery, "applied")
        return
      }
      if (delivery.generation > currentGeneration && currentGeneration !== 0) {
        acknowledger.acknowledge(delivery, "resync-required")
        return
      }
      const current = viewRef.current
      if (!current) {
        acknowledger.acknowledge(delivery, "resync-required")
        return
      }
      const result = applySessionPartDeltas(current, delivery)
      if (result.kind === "resync-required") {
        acknowledger.acknowledge(delivery, "resync-required")
        return
      }
      currentGeneration = delivery.generation
      viewRef.current = result.view
      setView(result.view)
      acknowledger.acknowledge(delivery, "applied")
    })
    void window.desktop.sessions
      .openAux({
        subscriptionId: detailsSubscriptionId,
        sessionId: childSessionId,
      })
      .then(
        (next) => {
          if (disposed) return
          viewRef.current = next
          setView(next)
          setLoading(false)
        },
        (cause) => {
          if (disposed) return
          setError(errorMessage(cause))
          setLoading(false)
        }
      )
    return () => {
      disposed = true
      unsubscribe()
      acknowledger.dispose()
      void window.desktop.sessions
        .closeAux({ subscriptionId: detailsSubscriptionId })
        .catch(() => {})
    }
  }, [childSessionId])

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
          <Badge variant={failed ? "destructive" : "outline"}>
            {agentTaskStatusLabel(task.status)}
          </Badge>
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
                  tasks={view.tasks}
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

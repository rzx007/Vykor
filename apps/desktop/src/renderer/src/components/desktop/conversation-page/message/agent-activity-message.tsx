import { Bot, ChevronRight } from "lucide-react"
import { Spinner } from "@renderer/components/ui/spinner"
import { useDesktopSessionStore } from "@renderer/stores/desktop-session"
import { agentTaskStatusLabel } from "../../tools/agents/agent-task-model"
import type { DesktopSessionPart, DesktopSessionTask } from "@shared/session-types"
import { cn } from "@renderer/lib/utils"
import { summarizeToolCall, toolCallStatus } from "./message-render-model"
import { toolOutputText } from "./message-content"
import { ElapsedTime } from "./task-duration"

const dispatchStatusLabels = {
  pending: "启动中",
  running: "启动中",
  completed: "已派出",
  failed: "启动失败",
  interrupted: "启动中断",
} as const

export function AgentActivityMessage({
  call,
  result,
  tasks,
  onOpenAgents,
}: {
  call: DesktopSessionPart
  result?: DesktopSessionPart
  tasks: readonly DesktopSessionTask[]
  onOpenAgents?: (taskId?: string) => void
}): React.JSX.Element {
  const output = toolOutputText(result?.output ?? result?.text ?? call.output) ?? ""
  const jobId = agentJobId(output)
  // 只按派出结果中的任务 ID 关联，避免同名任务串状态。
  const task = tasks.find((item) => item.type === "agent" && item.id === jobId)
  const needsInput = useDesktopSessionStore((state) =>
    Boolean(
      task?.childSessionId &&
      state.activity.sessions[task.childSessionId]?.executionState === "needs_input"
    )
  )
  const dispatchStatus = toolCallStatus(call, result)
  const failed = task
    ? task.status === "failed" || task.status === "interrupted"
    : dispatchStatus === "failed" || dispatchStatus === "interrupted"
  const active = task
    ? task.status === "running" || task.status === "pending"
    : dispatchStatus === "running" || dispatchStatus === "pending"
  const status = task
    ? needsInput && active
      ? "等待处理"
      : agentTaskStatusLabel(task.status)
    : dispatchStatusLabels[dispatchStatus]
  const label = task?.description || summarizeToolCall(call).detail || "派出子智能体"
  return (
    <button
      type="button"
      data-agent-activity
      disabled={!task?.childSessionId || !onOpenAgents}
      onClick={() => onOpenAgents?.(task?.id)}
      title={task?.error || (!task && failed ? output : label)}
      className="text-ui-small flex max-w-full min-w-0 items-center gap-2 rounded-sm py-1 text-left text-ui-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none enabled:hover:text-foreground"
    >
      <Bot className="size-4 shrink-0" strokeWidth={1.7} />
      <span className="shrink-0">子智能体</span>
      <span className="truncate font-medium text-foreground">{label}</span>
      {active && !needsInput ? <Spinner className="size-3 shrink-0" aria-hidden="true" /> : null}
      <span
        role="status"
        className={cn(
          "shrink-0 text-xs",
          failed && "text-destructive",
          needsInput && active && "text-amber-600 dark:text-amber-400"
        )}
      >
        {status}
      </span>
      <ElapsedTime
        key={task?.startedAt}
        startedAt={task?.startedAt}
        finishedAt={task?.finishedAt}
        running={active}
        prefix=" · "
      />
      {task?.childSessionId && onOpenAgents ? (
        <ChevronRight className="size-3 shrink-0" aria-hidden="true" />
      ) : null}
    </button>
  )
}

function agentJobId(text: string): string | undefined {
  try {
    const job = JSON.parse(text)
    return job?.kind === "job" &&
      job.jobKind === "agent" &&
      job.action === "created" &&
      typeof job.jobId === "string"
      ? job.jobId
      : undefined
  } catch {
    return undefined
  }
}

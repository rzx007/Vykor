import { useId, useState } from "react"
import { GitBranch, ChevronDown, ChevronRight } from "lucide-react"
import type { DesktopSessionPart } from "@shared/session-types"
import { Button } from "@renderer/components/ui/button"
import { AgentDisclosure } from "@renderer/components/agents/agent-disclosure"
import { cn } from "@renderer/lib/utils"
import { ToolDetails } from "../../conversation-page/message/tool-details"
import { useWorkflows } from "./workflow-provider"
import {
  workflowCounts,
  workflowProgress,
  workflowStatus,
  workflowToolRunId,
} from "./workflow-model"

export function WorkflowSummary({
  call,
  result,
}: {
  call: DesktopSessionPart
  result?: DesktopSessionPart
}) {
  const context = useWorkflows()
  const [expanded, setExpanded] = useState(false)
  const detailsId = useId()
  const id =
    typeof call.metadata.workflowRunId === "string"
      ? call.metadata.workflowRunId
      : typeof result?.metadata.workflowRunId === "string"
        ? result.metadata.workflowRunId
        : (workflowToolRunId(result?.output ?? call.output) ??
          (typeof call.input?.runId === "string" ? call.input.runId : undefined))
  const run =
    context?.sessionId === call.sessionId
      ? context.snapshot?.runs.find((run) => run.id === id)
      : undefined
  const counts = run?.detailsAvailable ? workflowCounts(run) : null
  const failed = run?.tasks.find((task) => task.status === "failed")
  const toolFailed = call.isError || result?.isError || call.status === "failed"
  const hasFailure = run ? run.status === "failed" || Boolean(failed) : Boolean(toolFailed)
  const status = run
    ? workflowStatus(run)
    : toolFailed
      ? "提交失败"
      : id
        ? "已提交，正在同步状态"
        : call.status === "running" || call.status === "pending"
          ? "正在提交编排"
          : "状态待确认"
  return (
    <div className="my-1 min-w-0 text-sm" data-workflow-summary={id}>
      <div className="flex min-h-14 flex-wrap items-center gap-x-3 gap-y-1 py-2">
        <div className="flex min-w-0 flex-1 basis-48 items-start gap-2.5">
          <GitBranch
            aria-hidden="true"
            className={cn(
              "mt-0.5 size-4 shrink-0",
              hasFailure ? "text-destructive" : "text-muted-foreground"
            )}
            strokeWidth={1.75}
          />
          <div className="min-w-0 flex-1">
            <p
              role="status"
              className={cn(
                "leading-5 font-medium",
                hasFailure ? "text-destructive" : "text-foreground"
              )}
            >
              {run ? `编排${status}` : status}
            </p>
            <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
              {context?.syncStatus === "reconnecting" ? "正在重新连接 · " : ""}
              {counts && run ? workflowProgress(run) : "状态同步后可查看任务进展"}
            </p>
            {run?.tasks.some((task) => task.status === "running") ? (
              <p className="mt-0.5 truncate text-xs leading-5 text-muted-foreground">
                当前：
                {run.tasks
                  .filter((task) => task.status === "running")
                  .map((task) => task.title)
                  .join("、")}
              </p>
            ) : null}
            {run?.needsReconciliation ? (
              <p className="mt-0.5 text-xs leading-5">有改动需要检查和合并</p>
            ) : null}
            {context?.error ? (
              <p className="mt-0.5 text-xs leading-5 text-destructive">
                状态更新失败，显示上次结果
              </p>
            ) : null}
          </div>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {id && context?.sessionId === call.sessionId ? (
            <Button
              variant="ghost"
              shape="pill"
              size="sm"
              className={cn(hasFailure && "text-destructive hover:text-destructive")}
              onClick={() => context.open(id, failed?.id)}
            >
              {failed ? "查看失败节点" : run?.status === "completed" ? "查看结果" : "查看编排"}
              <ChevronRight data-icon="inline-end" />
            </Button>
          ) : null}
          <Button
            variant="ghost"
            shape="circle"
            size="icon-sm"
            aria-label="原始调用"
            title={expanded ? "收起原始调用" : "展开原始调用"}
            aria-controls={detailsId}
            aria-expanded={expanded}
            className="text-muted-foreground"
            onClick={() => setExpanded((value) => !value)}
          >
            <ChevronDown
              aria-hidden="true"
              className={cn(
                "size-3.5 motion-safe:transition-transform motion-safe:duration-150",
                expanded && "rotate-180"
              )}
            />
          </Button>
        </div>
      </div>
      <AgentDisclosure id={detailsId} open={expanded}>
        {expanded ? (
          <div className="mb-2 ml-6.5 overflow-hidden rounded-lg border border-border/70">
            <ToolDetails
              tool={{ id: call.id, type: "tool", call, result }}
              calling={call.status === "running" || call.status === "pending"}
            />
          </div>
        ) : null}
      </AgentDisclosure>
    </div>
  )
}

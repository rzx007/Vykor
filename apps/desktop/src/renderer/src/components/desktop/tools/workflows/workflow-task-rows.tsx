import { ArrowUpRight } from "lucide-react"
import { TaskRows, type TaskRow } from "@renderer/components/agents/task-rows"
import { Button } from "@renderer/components/ui/button"
import type { DesktopWorkflowRun } from "@shared/workflow-types"
import { workflowTaskLabel, workflowWaitText } from "./workflow-model"
import { WorkflowOutputFiles, WorkflowChangedFiles } from "./workflow-output"

export function WorkflowTaskRows({
  run,
  onSelect,
  onOpenFile,
  onOpenReview,
}: {
  run: DesktopWorkflowRun
  onSelect(id: string): void
  onOpenFile(path: string): void
  onOpenReview(path?: string, rootPath?: string): void
}) {
  const rows: TaskRow[] = run.tasks.map((task, index) => {
    const elapsed =
      task.startedAt !== undefined && task.finishedAt !== undefined
        ? Math.max(0, Math.round((task.finishedAt - task.startedAt) / 1000))
        : undefined
    return {
      key: task.id,
      label: task.title.replace(/^任务\s*\d+\s*[:：]\s*/u, ""),
      ariaLabel: `展开任务：${task.title}`,
      amount: elapsed !== undefined ? `${elapsed} 秒` : "",
      status: task.cleanupUnconfirmed
        ? "unknown"
        : task.status === "completed"
          ? "done"
          : task.status,
      statusLabel: workflowTaskLabel(task),
      step: index + 1,
      details: [],
    }
  })
  return (
    <section aria-label="任务进展">
      <h3 className="mb-3 text-sm font-semibold">
        {run.status === "completed" ? "任务" : "任务进展"}
      </h3>
      <TaskRows
        rows={rows}
        labels={{ completed: "已完成", failed: "失败" }}
        renderDetails={(row) => {
          const task = run.tasks.find((task) => task.id === row.key)!
          const wait = workflowWaitText(task, run)
          const summary =
            task.error ??
            (task.summary !== `${task.id} finished with status ${task.status}`
              ? task.summary
              : undefined)
          return (
            <>
              {wait ? <p className="text-xs text-muted-foreground">{wait}</p> : null}
              {summary ? (
                <p className="line-clamp-3 text-xs break-words whitespace-pre-wrap text-muted-foreground">
                  {summary}
                </p>
              ) : null}
              <WorkflowOutputFiles tasks={[task]} onOpenFile={onOpenFile} compact />
              <WorkflowChangedFiles
                task={task}
                onOpenFile={onOpenFile}
                onOpenReview={onOpenReview}
              />
              <Button
                variant="ghost"
                shape="pill"
                size="sm"
                aria-label={`查看任务：${task.title}`}
                onClick={() => onSelect(task.id)}
              >
                查看任务详情
                <ArrowUpRight data-icon="inline-end" />
              </Button>
            </>
          )
        }}
      />
    </section>
  )
}

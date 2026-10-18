import { FileText, ArrowUpRight } from "lucide-react"
import { getFileIcon } from "../file-icons"
import type { DesktopWorkflowTask } from "@shared/workflow-types"
import { Button } from "@renderer/components/ui/button"
import { workflowOutputFiles } from "./workflow-model"

export function WorkflowOutputFiles({
  tasks,
  onOpenFile,
  compact = false,
}: {
  tasks: DesktopWorkflowTask[]
  onOpenFile(path: string): void
  compact?: boolean
}) {
  const seen = new Set<string>()
  const files = tasks.flatMap((task) =>
    workflowOutputFiles(task).flatMap((path) => {
      const key = /^[a-z]:/i.test(path) ? path.replace(/\\/g, "/").toLowerCase() : path
      if (seen.has(key)) return []
      seen.add(key)
      return [{ path, task }]
    })
  )
  if (!files.length) return null
  return (
    <section aria-label="返回结果中的文件">
      {!compact ? <h3 className="mb-3 text-sm font-semibold">文件</h3> : null}
      <ul className="space-y-1">
        {files.map(({ path, task }) => {
          const name = path.split(/[\\/]/).pop()!
          const Icon = getFileIcon(path)
          return (
            <li key={path}>
              <button
                type="button"
                aria-label={`打开文件：${name}`}
                title={path}
                onClick={() => onOpenFile(path)}
                className="flex min-h-14 w-full items-center gap-3 rounded-lg px-3 py-2 text-left hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                <Icon
                  aria-hidden="true"
                  className="size-5 shrink-0 text-muted-foreground"
                  strokeWidth={1.75}
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium break-words">{name}</span>
                  {!compact ? (
                    <span
                      className="mt-0.5 block truncate text-xs text-muted-foreground"
                      title={task.title}
                    >
                      来自任务 {tasks.findIndex((candidate) => candidate.id === task.id) + 1}
                    </span>
                  ) : null}
                </span>
                <ArrowUpRight
                  aria-hidden="true"
                  className="size-4 shrink-0 text-muted-foreground"
                  strokeWidth={1.75}
                />
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

export function WorkflowChangedFiles({
  task,
  onOpenFile,
  onOpenReview,
}: {
  task: DesktopWorkflowTask
  onOpenFile(path: string): void
  onOpenReview(path?: string, rootPath?: string): void
}) {
  if (!task.changedFiles.length) return null
  return (
    <section aria-label="文件改动">
      <h3 className="mb-2 text-sm font-semibold">文件改动</h3>
      {task.changedFiles.map((path) => (
        <div key={path} className="flex min-w-0 items-center gap-1">
          <Button
            variant="ghost"
            className="min-w-0 flex-1 justify-start"
            onClick={() =>
              onOpenFile(
                task.worktreePath && !/^(?:[a-z]:[\\/]|\/)/i.test(path)
                  ? `${task.worktreePath}/${path}`
                  : path
              )
            }
          >
            <FileText data-icon="inline-start" />
            <span className="truncate">{path}</span>
          </Button>
          <Button
            variant="ghost"
            shape="pill"
            size="sm"
            onClick={() => onOpenReview(path, task.worktreePath)}
          >
            查看改动
          </Button>
        </div>
      ))}
    </section>
  )
}

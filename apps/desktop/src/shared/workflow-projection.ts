import type { JobReadResult } from "@rzx/client"
import type {
  DesktopWorkflowRun,
  DesktopWorkflowTask,
  DesktopWorkflowTaskStatus,
} from "./workflow-types"

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined)
const number = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []
const statuses = new Set<DesktopWorkflowTaskStatus>([
  "pending",
  "running",
  "completed",
  "failed",
  "killed",
  "skipped",
  "unknown",
])

/** Only structured Job details determine execution state; worker prose is display text. */
export function projectWorkflowRun(read: JobReadResult): DesktopWorkflowRun {
  const job = read.snapshot
  const details = record(read.details)
  const plan = record(details.plan)
  const definitions = Array.isArray(plan.tasks) ? plan.tasks.map(record) : []
  const results = record(details.results)
  const running = record(details.runningTasks)
  const blocked = record(details.blockedTasks)
  const dependencyMap = record(plan.dependencyMap)
  const valid =
    definitions.length > 0 &&
    definitions.every((task) => typeof task.id === "string" && task.id.length > 0)
  const tasks: DesktopWorkflowTask[] = valid
    ? definitions.map((task) => {
        const id = task.id as string
        const result = record(results[id])
        const active = record(running[id])
        const wait = record(blocked[id])
        const metadata = record(result.metadata ?? active.metadata)
        const dependencies = strings(dependencyMap[id] ?? task.dependsOn)
        const rawStatus =
          result.status ??
          (running[id] ? "running" : job.status === "running" ? "pending" : "unknown")
        const status = statuses.has(rawStatus as DesktopWorkflowTaskStatus)
          ? (rawStatus as DesktopWorkflowTaskStatus)
          : "unknown"
        const unmet = dependencies.filter((dependency) =>
          details.failurePolicy === "continue"
            ? !["completed", "failed", "killed", "skipped"].includes(
                String(record(results[dependency]).status)
              )
            : record(results[dependency]).status !== "completed"
        )
        const waitReason =
          status !== "pending"
            ? undefined
            : blocked[id]
              ? "write_conflict"
              : unmet.length
                ? "dependency"
                : "capacity"
        return {
          id,
          title: text(task.description) || id,
          prompt: text(task.prompt),
          dependencies,
          status,
          summary: text(result.summary ?? result.skippedReason ?? active.summary ?? wait.reason),
          result: text(result.result),
          error: text(result.error ?? metadata.stopError),
          // A running snapshot does not reliably advance its attempt field during retries.
          attempts: number(result.attempts),
          startedAt: number(result.startedAt ?? active.startedAt),
          finishedAt: number(result.finishedAt),
          workerTaskId: text(metadata.workerTaskId),
          model: text(task.model),
          subagentType: text(task.subagentType),
          worktreePath: text(record(metadata.worktree).path),
          changedFiles: strings(metadata.changedFiles),
          writeScope: strings(task.writeScope),
          waitingForTaskIds:
            waitReason === "write_conflict" ? strings(wait.waitingForTaskIds) : unmet,
          waitReason,
          timedOut: result.timedOut === true || metadata.timedOut === true,
          cleanupUnconfirmed:
            result.cleanupUnconfirmed === true ||
            metadata.cleanupUnconfirmed === true ||
            typeof metadata.stopError === "string",
        }
      })
    : []
  return {
    id: job.id,
    jobId: job.id,
    target: job.target,
    sessionId: job.ownerSession,
    title: job.label,
    status: details.termination === "cancelled" ? "killed" : job.status,
    summary: text(details.summary) ?? job.label,
    startedAt: job.startedAt,
    updatedAt: job.updatedAt,
    finishedAt: job.finishedAt,
    canCancel: job.capabilities.cancel,
    mode: text(plan.mode),
    maxConcurrency: number(plan.maxConcurrency),
    tasks,
    detailsAvailable: valid,
    needsReconciliation: details.needsReconciliation === true,
    reconciliationIssues: Array.isArray(details.reconciliationIssues)
      ? details.reconciliationIssues.flatMap((issue) => text(record(issue).summary) ?? [])
      : [],
    tokensUsed: number(record(details.budget).tokensUsed),
    events: Array.isArray(details.events)
      ? details.events.flatMap((value) => {
          const event = record(value)
          return typeof event.type === "string" && number(event.timestamp) !== undefined
            ? [
                {
                  type: event.type,
                  timestamp: event.timestamp as number,
                  taskId: text(event.taskId),
                  summary: text(event.summary),
                },
              ]
            : []
        })
      : [],
    eventsTruncated: details.eventsTruncated === true,
  }
}

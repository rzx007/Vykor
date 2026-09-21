import type { OpenHarnessClientState, ScheduledRunRecord, SessionBucket } from "@openharness/client"
import type {
  DesktopExecutionState,
  DesktopScheduledActivity,
  DesktopSessionActivity,
} from "@shared/activity-types"

export function projectSessionActivity(
  state: OpenHarnessClientState,
  sessionId: string,
  activitySeq: number
): DesktopSessionActivity | undefined {
  const bucket = state.buckets[sessionId]
  const session = bucket?.session
  if (!session) return undefined
  const permission = Object.values(bucket.permissions)
    .filter((item) => item.status === "pending")
    .sort((a, b) => b.updatedAt - a.updatedAt)[0]
  const run = latestRun(bucket)
  const executionState: DesktopExecutionState = permission
    ? "needs_input"
    : run?.status === "pending" || run?.status === "running"
      ? "running"
      : run?.status === "completed"
        ? "completed"
        : run?.status === "failed"
          ? "failed"
          : run?.status === "interrupted"
            ? "interrupted"
            : session.status === "running"
              ? "running"
              : session.status === "error"
                ? "failed"
                : "idle"
  return {
    session,
    executionState,
    attentionState: "read",
    activitySeq,
    updatedAt: session.updatedAt,
    ...(run && { runId: run.id }),
    ...(permission && { permissionId: permission.id }),
    ...(run?.error && { error: run.error }),
  }
}

function latestRun(bucket: SessionBucket) {
  return Object.values(bucket.runs).sort(
    (a, b) => b.createdAt - a.createdAt || b.updatedAt - a.updatedAt
  )[0]
}

export function projectScheduledActivity(
  run: ScheduledRunRecord,
  activitySeq: number
): DesktopScheduledActivity {
  const executionState: DesktopExecutionState =
    run.status === "queued" || run.status === "running"
      ? "running"
      : run.status === "needs_attention"
        ? "needs_input"
        : run.status === "failed"
          ? "failed"
          : run.status === "interrupted"
            ? "interrupted"
            : "completed"
  return {
    taskId: run.taskId,
    run,
    executionState,
    attentionState: run.unread ? "unread" : "read",
    activitySeq,
    updatedAt: run.updatedAt,
  }
}

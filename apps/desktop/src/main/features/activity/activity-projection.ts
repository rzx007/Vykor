import type { VykorClientState, ScheduledRunRecord, SessionBucket } from "@rzx/client"
import type {
  DesktopExecutionState,
  DesktopScheduledActivity,
  DesktopSessionActivity,
} from "@shared/activity-types"

export function projectSessionActivity(
  state: VykorClientState,
  sessionId: string,
  activitySeq: number
): DesktopSessionActivity | undefined {
  const bucket = state.buckets[sessionId]
  const session = bucket?.session
  if (!session) return undefined
  const permission = Object.values(bucket.permissions)
    .filter((item) => {
      if (item.status !== "pending") return false
      // Pending includes automatic handling, not just requests waiting for a person.
      if (typeof item.payload.reusedApprovalRequestId === "string" && item.payload.reusedApprovalRequestId) return false
      const review = item.payload.approvalReview
      const status = review && typeof review === "object" && !Array.isArray(review)
        ? (review as Record<string, unknown>).status
        : undefined
      return status !== "reviewing" && status !== "approved" && status !== "denied"
    })
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

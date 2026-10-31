import type {
  VykorClientState,
  ScheduledRunRecord,
  SessionBucket,
  SessionGoal,
} from "@vykor/application-client"
import type {
  DesktopExecutionState,
  DesktopScheduledActivity,
  DesktopSessionActivity,
} from "@shared/activity-types"

export function projectSessionActivity(
  state: VykorClientState,
  sessionId: string,
  activitySeq: number,
  goal?: SessionGoal
): DesktopSessionActivity | undefined {
  const bucket = state.buckets[sessionId]
  const session = bucket?.session
  if (!session) return undefined
  const permission = Object.values(bucket.permissions)
    .filter((item) => {
      if (item.status !== "pending") return false
      // Pending includes automatic handling, not just requests waiting for a person.
      if (
        typeof item.payload.reusedApprovalRequestId === "string" &&
        item.payload.reusedApprovalRequestId
      )
        return false
      const review = item.payload.approvalReview
      const status =
        review && typeof review === "object" && !Array.isArray(review)
          ? (review as Record<string, unknown>).status
          : undefined
      return status !== "reviewing" && status !== "approved" && status !== "denied"
    })
    .sort((a, b) => b.updatedAt - a.updatedAt)[0]
  const run = latestRun(bucket)
  // A later ordinary prompt owns its own result, even if an old goal is still cached.
  const currentGoal =
    goal?.sessionId === sessionId &&
    (!run || run.metadata.goalId === goal.id || run.createdAt < goal.createdAt)
      ? goal
      : undefined
  const goalActivity = currentGoal ? projectGoalActivity(currentGoal, run) : undefined
  const runState: DesktopExecutionState =
    run?.status === "pending" || run?.status === "running"
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
  const executionState = permission ? "needs_input" : (goalActivity?.executionState ?? runState)
  const scheduledRunId = run?.metadata.scheduledRunId
  return {
    session,
    executionState,
    attentionState: "read",
    activitySeq,
    updatedAt: Math.max(session.updatedAt, currentGoal?.updatedAt ?? 0),
    ...(run && { runId: run.id }),
    ...(permission && { permissionId: permission.id }),
    ...(!permission && goalActivity?.attentionId ? { attentionId: goalActivity.attentionId } : {}),
    ...(typeof scheduledRunId === "string" && scheduledRunId.length > 0 ? { scheduledRunId } : {}),
    ...(run?.error && { error: run.error }),
  }
}

function projectGoalActivity(
  goal: SessionGoal,
  run: ReturnType<typeof latestRun>
): Pick<DesktopSessionActivity, "executionState" | "attentionId"> | undefined {
  if (goal.status === "active") {
    // Goal settlement runs after the round's terminal event has already been published.
    if (run?.status === "failed" || run?.status === "interrupted") return undefined
    return { executionState: "running" }
  }
  if (goal.status === "completed") return { executionState: "completed" }
  if (goal.status === "cancelled") return { executionState: "interrupted" }
  if (goal.status === "waiting_user") {
    if (goal.wait?.kind === "user")
      return {
        executionState: "needs_input",
        attentionId: `goal:${goal.id}:question:${goal.wait.questionId}`,
      }
    // Approval attention belongs to the live permission, not a possibly resolved wait.
    return { executionState: "running" }
  }
  if (goal.status === "paused") {
    const code = goal.stopReason?.code
    if (code === "user_paused" || code === "user_cancelled" || code === "updating_objective")
      return { executionState: "interrupted" }
    if (
      code === "run_error" ||
      code === "external_failed" ||
      code === "wait_invalid" ||
      code === "wait_timeout"
    )
      return { executionState: "failed" }
  }
  return {
    executionState: "needs_input",
    attentionId: `goal:${goal.id}:${goal.objectiveVersion}:${goal.status}:${goal.revision}`,
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
            : run.status === "skipped"
              ? "idle"
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

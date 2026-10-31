import type { DesktopScheduledRun } from "./schedule-types"
import type { DesktopSessionRecord } from "./session-types"

export type DesktopExecutionState =
  "idle" | "running" | "needs_input" | "completed" | "failed" | "interrupted"

export type DesktopAttentionState = "read" | "unread"
export type DesktopActivityDelivery = "baseline" | "live" | "catchup" | "reconnecting"

export interface DesktopSessionActivity {
  session: DesktopSessionRecord
  executionState: DesktopExecutionState
  attentionState: DesktopAttentionState
  activitySeq: number
  updatedAt: number
  runId?: string
  permissionId?: string
  /** Stable identity for a goal question or another actionable stop without a permission request. */
  attentionId?: string
  /** Scheduler owns terminal notifications for this exact run, even inside an existing chat. */
  scheduledRunId?: string
  error?: string
}

export interface DesktopScheduledActivity {
  taskId: string
  run: DesktopScheduledRun
  executionState: DesktopExecutionState
  attentionState: DesktopAttentionState
  activitySeq: number
  updatedAt: number
}

export interface DesktopActivityUpdate {
  cursor: number
  delivery: DesktopActivityDelivery
  sessions: DesktopSessionActivity[]
  scheduled: DesktopScheduledActivity[]
  eventType?: string
  previousStatus?: string
  removedTaskId?: string
  removedSessionIds?: string[]
}

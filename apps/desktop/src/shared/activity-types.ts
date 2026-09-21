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

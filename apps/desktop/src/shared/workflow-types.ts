import type { JobStatus } from "@rzx/client"

export type DesktopWorkflowTaskStatus =
  "pending" | "running" | "completed" | "failed" | "killed" | "skipped" | "unknown"

export interface DesktopWorkflowTask {
  id: string
  title: string
  prompt?: string
  dependencies: string[]
  status: DesktopWorkflowTaskStatus
  summary?: string
  result?: string
  error?: string
  attempts?: number
  startedAt?: number
  finishedAt?: number
  workerTaskId?: string
  model?: string
  subagentType?: string
  worktreePath?: string
  changedFiles: string[]
  writeScope: string[]
  waitingForTaskIds: string[]
  waitReason?: "dependency" | "capacity" | "write_conflict"
  timedOut: boolean
  cleanupUnconfirmed: boolean
  needsInput?: boolean
}

export interface DesktopWorkflowEvent {
  type: string
  timestamp: number
  taskId?: string
  summary?: string
}

export interface DesktopWorkflowRun {
  id: string
  jobId: string
  sessionId: string
  title: string
  status: JobStatus
  summary: string
  startedAt: number
  updatedAt: number
  finishedAt?: number
  canCancel: boolean
  mode?: string
  maxConcurrency?: number
  tasks: DesktopWorkflowTask[]
  detailsAvailable: boolean
  needsReconciliation: boolean
  reconciliationIssues: string[]
  tokensUsed?: number
  events: DesktopWorkflowEvent[]
  eventsTruncated: boolean
}

export interface DesktopWorkflowSnapshot {
  sessionId: string
  runs: DesktopWorkflowRun[]
  hasMore: boolean
  errors: Array<{ jobId: string; message: string }>
}

export interface DesktopWorkflowInput {
  sessionId: string
  jobId?: string
}
export interface DesktopWorkflowCancelInput extends DesktopWorkflowInput {
  jobId: string
}

export interface DesktopWorkflowAPI {
  read: (input: DesktopWorkflowInput) => Promise<DesktopWorkflowSnapshot>
  cancel: (input: DesktopWorkflowCancelInput) => Promise<void>
}

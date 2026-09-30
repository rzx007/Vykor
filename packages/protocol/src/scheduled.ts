export type ScheduledTaskStatus = "active" | "paused" | "completed";
export type ScheduledTaskDestination = "standalone" | "chat";
export type ScheduledTaskExecutionMode = "local" | "worktree";
export type ScheduledRecurrenceFormat = "rrule" | "once";
export type ScheduledOverlapPolicy = "skip" | "queue";
export type ScheduledMissedRunPolicy = "skip" | "run_once";

export interface ScheduledPermissionProfile {
  mode: "read_only" | "workspace_write" | "full_access";
  network?: boolean;
  allowedTools?: string[];
  deniedTools?: string[];
}

export interface ScheduledStopPolicy {
  runOnce?: boolean;
  maxRuns?: number;
  stopWhenCompleted?: boolean;
  expiresAt?: number;
}

export interface ScheduledTaskRecord {
  id: string;
  name: string;
  description?: string;
  prompt: string;
  recurrence: string;
  recurrenceFormat: ScheduledRecurrenceFormat;
  timezone: string;
  status: ScheduledTaskStatus;
  destination: ScheduledTaskDestination;
  sessionId?: string;
  projectPaths: string[];
  executionMode: ScheduledTaskExecutionMode;
  model?: string;
  effort?: string;
  skillNames: string[];
  pluginNames: string[];
  permissionProfile: ScheduledPermissionProfile;
  overlapPolicy: ScheduledOverlapPolicy;
  missedRunPolicy: ScheduledMissedRunPolicy;
  stopPolicy?: ScheduledStopPolicy;
  createdBy: "user" | "agent";
  createdFromSessionId?: string;
  lastRunAt?: number;
  nextRunAt?: number;
  runCount: number;
  createdAt: number;
  updatedAt: number;
}

export type ScheduledRunCause = "scheduled" | "manual" | "missed_run";
export type ScheduledRunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "interrupted"
  | "needs_attention"
  | "skipped";

export interface ScheduledRunRecord {
  id: string;
  taskId: string;
  cause: ScheduledRunCause;
  status: ScheduledRunStatus;
  scheduledFor: number;
  sessionId?: string;
  runId?: string;
  summary?: string;
  error?: string;
  unread: boolean;
  attentionReason?: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  updatedAt: number;
}

export interface CreateScheduledTaskInput {
  id?: string;
  name: string;
  description?: string;
  prompt: string;
  recurrence: string;
  recurrenceFormat: ScheduledRecurrenceFormat;
  timezone: string;
  status?: ScheduledTaskStatus;
  destination: ScheduledTaskDestination;
  sessionId?: string;
  projectPaths?: string[];
  executionMode?: ScheduledTaskExecutionMode;
  model?: string;
  effort?: string;
  skillNames?: string[];
  pluginNames?: string[];
  permissionProfile?: ScheduledPermissionProfile;
  overlapPolicy?: ScheduledOverlapPolicy;
  missedRunPolicy?: ScheduledMissedRunPolicy;
  stopPolicy?: ScheduledStopPolicy;
  createdBy?: ScheduledTaskRecord["createdBy"];
  createdFromSessionId?: string;
  nextRunAt?: number;
}

export type UpdateScheduledTaskInput = Partial<
  Omit<CreateScheduledTaskInput, "id" | "nextRunAt">
> & {
  lastRunAt?: number | null;
  nextRunAt?: number | null;
  runCount?: number;
};

export interface CreateScheduledRunInput {
  id?: string;
  taskId: string;
  cause: ScheduledRunCause;
  scheduledFor: number;
}

export interface UpdateScheduledRunInput {
  status?: ScheduledRunStatus;
  sessionId?: string;
  runId?: string;
  summary?: string;
  error?: string;
  unread?: boolean;
  attentionReason?: string;
  startedAt?: number;
  finishedAt?: number;
}

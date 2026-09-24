export type JobKind = "terminal" | "shell" | "agent" | "dream" | "workflow";

export type JobStatus =
  | "running"
  | "stopping"
  | "completed"
  | "killed"
  | "failed";

export interface JobCapabilities {
  read: boolean;
  wait: boolean;
  send: boolean;
  cancel: boolean;
}

/** 可以通过 HTTP 返回的 Job 当前状态；不包含进程句柄或等待中的 Promise。 */
export interface JobSnapshot {
  id: string;
  kind: JobKind;
  label: string;
  ownerSession: string;
  status: JobStatus;
  capabilities: JobCapabilities;
  cwd: string;
  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
  exitCode?: number | null;
  detail?: string;
  metadata?: Record<string, unknown>;
}

export interface JobReadResult {
  text: string;
  cursor: number;
  truncated: boolean;
  snapshot: JobSnapshot;
  details?: Record<string, unknown>;
}

export interface JobWaitResult extends JobReadResult {
  timedOut: boolean;
}

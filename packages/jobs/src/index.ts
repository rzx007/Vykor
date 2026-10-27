import type { JobKind, JobReadResult, JobSnapshot, JobStatus, JobWaitResult, JobTarget, JobInputReceipt, JobListResult } from "./contracts.js";

export { RoutedAgentJobHost } from "./routed-agent-job-host.js";

export type { JobCapabilities, JobKind, JobReadResult, JobSnapshot, JobStatus, JobWaitResult, JobTarget, JobInputReceipt, JobListResult } from "./contracts.js";

export interface JobReadRequest {
  sessionId: string;
  target: JobTarget;
  after?: number;
  maxChars?: number;
}

export interface JobWaitRequest extends JobReadRequest {
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface JobSendRequest {
  sessionId: string;
  target: JobTarget;
  data: string;
}

export interface JobCancelRequest {
  sessionId: string;
  target: JobTarget;
  reason?: string;
}

export interface JobListRequest {
  sessionId: string;
  kinds?: JobKind[];
  statuses?: JobStatus[];
  startedAfter?: number;
  startedBefore?: number;
  updatedAfter?: number;
  updatedBefore?: number;
  includeFinished?: boolean;
  limit?: number;
}

/** Host-owned job controller exposed to an Agent. */
export interface AgentJobAuthorization {
  /** Trusted calling Run evidence; opaque to the portable Jobs package. */
  readonly parent?: unknown;
  readonly pluginId?: string;
  readonly pluginIds?: ReadonlySet<string>;
  /** Host-captured binding evidence, forwarded without interpreting it in jobs. */
  readonly tools?: ReadonlyMap<string, unknown>;
  readonly delegatableTools?: ReadonlyMap<string, unknown>;
  readonly skills?: ReadonlyMap<string, unknown>;
  readonly agents?: ReadonlyMap<string, unknown>;
  readonly mcpServers?: ReadonlyMap<string, unknown>;
}

/** Host-owned job controller exposed to an Agent. */
export interface AgentJobHost {
  list(input: JobListRequest): Promise<JobListResult>;
  read(input: JobReadRequest): Promise<JobReadResult>;
  wait(input: JobWaitRequest): Promise<JobWaitResult>;
  /** Authorization comes from the current host Run, never from model-provided input. */
  send(input: JobSendRequest, authorization?: AgentJobAuthorization): Promise<JobInputReceipt | void>;
  cancel(input: JobCancelRequest): Promise<JobSnapshot>;
}

export function isTerminalJobStatus(status: JobStatus): boolean {
  return status === "completed" || status === "killed" || status === "failed";
}

/** Apply the portable JobList query contract after a host has projected its jobs. */
export function filterJobSnapshots(
  jobs: Iterable<JobSnapshot>,
  input: Omit<JobListRequest, "sessionId">,
): JobSnapshot[] {
  validateTimestamp(input.startedAfter, "startedAfter");
  validateTimestamp(input.startedBefore, "startedBefore");
  validateTimestamp(input.updatedAfter, "updatedAfter");
  validateTimestamp(input.updatedBefore, "updatedBefore");
  if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit <= 0)) {
    throw new Error("Job list limit must be a positive integer.");
  }

  const filtered = [...jobs]
    .filter((job) => !input.kinds?.length || input.kinds.includes(job.kind))
    .filter((job) => !input.statuses?.length || input.statuses.includes(job.status))
    .filter((job) => input.includeFinished !== false || !isTerminalJobStatus(job.status))
    .filter((job) => input.startedAfter === undefined || job.startedAt >= input.startedAfter)
    .filter((job) => input.startedBefore === undefined || job.startedAt <= input.startedBefore)
    .filter((job) => input.updatedAfter === undefined || job.updatedAt >= input.updatedAfter)
    .filter((job) => input.updatedBefore === undefined || job.updatedAt <= input.updatedBefore)
    .sort((left, right) => right.startedAt - left.startedAt);
  return input.limit === undefined ? filtered : filtered.slice(0, input.limit);
}

function validateTimestamp(value: number | undefined, name: string): void {
  if (value !== undefined && !Number.isFinite(value)) {
    throw new Error(`Job list ${name} must be a finite timestamp.`);
  }
}

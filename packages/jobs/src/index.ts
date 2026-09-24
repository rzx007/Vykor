import type {
  JobKind,
  JobReadResult,
  JobSnapshot,
  JobStatus,
  JobWaitResult,
} from "@vykor/protocol";

export { CompositeAgentJobHost } from "./composite-agent-job-host.js";

/** Jobs 包对外汇总它实际使用的跨端协议类型。 */
export type {
  JobCapabilities,
  JobKind,
  JobReadResult,
  JobSnapshot,
  JobStatus,
  JobWaitResult,
} from "@vykor/protocol";

export interface JobReadRequest {
  sessionId: string;
  jobId: string;
  after?: number;
  maxChars?: number;
}

export interface JobWaitRequest extends JobReadRequest {
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface JobSendRequest {
  sessionId: string;
  jobId: string;
  data: string;
}

export interface JobCancelRequest {
  sessionId: string;
  jobId: string;
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
export interface AgentJobHost {
  list(input: JobListRequest): Promise<JobSnapshot[]>;
  read(input: JobReadRequest): Promise<JobReadResult>;
  wait(input: JobWaitRequest): Promise<JobWaitResult>;
  /** Authorization comes from the current host Run, never from model-provided input. */
  send(input: JobSendRequest, authorization?: { readonly pluginId?: string }): Promise<void>;
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

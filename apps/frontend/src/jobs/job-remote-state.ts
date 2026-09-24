import type { JobReadResult, JobSnapshot } from "@vykor/client";

export type JobRemoteState =
  | { status: "idle"; jobs: JobSnapshot[] }
  | { status: "loading"; jobs: JobSnapshot[] }
  | { status: "ready"; jobs: JobSnapshot[]; refreshedAt: number }
  | { status: "error"; jobs: JobSnapshot[]; error: string; refreshedAt?: number };

export type JobDetailRemoteState =
  | { status: "idle" }
  | { status: "loading"; jobId: string; previous?: JobReadResult }
  | { status: "ready"; jobId: string; result: JobReadResult; refreshedAt: number }
  | { status: "error"; jobId: string; error: string; previous?: JobReadResult };

export function beginJobList(previous: JobRemoteState): JobRemoteState {
  return { status: "loading", jobs: [...previous.jobs] };
}

export function resolveJobList(
  jobs: JobSnapshot[],
  now: number,
  previous?: JobRemoteState,
): JobRemoteState {
  const cachedById = new Map(previous?.jobs.map((job) => [job.id, job]) ?? []);
  return {
    status: "ready",
    jobs: jobs.map((snapshot) => preferMonotonicSnapshot(cachedById.get(snapshot.id), snapshot)),
    refreshedAt: now,
  };
}

export function rejectJobList(previous: JobRemoteState, error: string): JobRemoteState {
  const refreshedAt = "refreshedAt" in previous ? previous.refreshedAt : undefined;
  return {
    status: "error",
    jobs: [...previous.jobs],
    error,
    ...(refreshedAt !== undefined ? { refreshedAt } : {}),
  };
}

export function mergeJobSnapshot(
  state: JobRemoteState,
  snapshot: JobSnapshot,
  now: number,
): JobRemoteState {
  const found = state.jobs.some((job) => job.id === snapshot.id);
  const jobs = found
    ? state.jobs.map((job) => job.id === snapshot.id ? preferMonotonicSnapshot(job, snapshot) : job)
    : [snapshot, ...state.jobs];
  return { status: "ready", jobs, refreshedAt: now };
}

function preferMonotonicSnapshot(
  cached: JobSnapshot | undefined,
  incoming: JobSnapshot,
): JobSnapshot {
  if (!cached) return incoming;
  if (isTerminalStatus(cached.status) && !isTerminalStatus(incoming.status)) return cached;
  if (incoming.updatedAt < cached.updatedAt) return cached;
  return incoming;
}

function isTerminalStatus(status: JobSnapshot["status"]): boolean {
  return status === "completed" || status === "killed" || status === "failed";
}

const JOB_KINDS = ["terminal", "shell", "agent", "dream", "workflow"] as const;
const JOB_STATUSES = ["running", "stopping", "completed", "killed", "failed"] as const;

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJobSnapshot(value: unknown, ownerSession: string): value is JobSnapshot {
  if (!isRecord(value)) {
    return false;
  }

  const capabilities = value.capabilities;
  return (
    typeof value.id === "string" &&
    value.id.trim().length > 0 &&
    value.ownerSession === ownerSession &&
    typeof value.label === "string" &&
    typeof value.cwd === "string" &&
    typeof value.kind === "string" &&
    JOB_KINDS.includes(value.kind as (typeof JOB_KINDS)[number]) &&
    typeof value.status === "string" &&
    JOB_STATUSES.includes(value.status as (typeof JOB_STATUSES)[number]) &&
    Number.isFinite(value.startedAt) &&
    Number.isFinite(value.updatedAt) &&
    (value.finishedAt === undefined || Number.isFinite(value.finishedAt)) &&
    (value.detail === undefined || typeof value.detail === "string") &&
    (value.metadata === undefined || isRecord(value.metadata)) &&
    isRecord(capabilities) &&
    typeof capabilities.read === "boolean" &&
    typeof capabilities.wait === "boolean" &&
    typeof capabilities.send === "boolean" &&
    typeof capabilities.cancel === "boolean"
  );
}

export function validateJobSnapshot(
  value: unknown,
  ownerSession: string,
  expectedJobId?: string,
): { snapshot?: JobSnapshot; error?: string } {
  if (!isRecord(value)) {
    return { error: "Job snapshot has invalid fields." };
  }
  if (typeof value.id === "string" && expectedJobId !== undefined && value.id !== expectedJobId) {
    return { error: `Job snapshot id "${value.id}" does not match requested Job "${expectedJobId}".` };
  }
  if (typeof value.ownerSession === "string" && value.ownerSession !== ownerSession) {
    return { error: `Job snapshot ownerSession "${value.ownerSession}" does not match active session "${ownerSession}".` };
  }
  if (!isJobSnapshot(value, ownerSession)) {
    return { error: "Job snapshot has invalid fields." };
  }
  return { snapshot: value };
}

export function validateJobReadResult(
  value: unknown,
  ownerSession: string,
  expectedJobId: string,
): { result?: JobReadResult; error?: string } {
  if (
    !isRecord(value) ||
    typeof value.text !== "string" ||
    !Number.isFinite(value.cursor) ||
    typeof value.truncated !== "boolean" ||
    (value.details !== undefined && !isRecord(value.details))
  ) {
    return { error: `Job read response for "${expectedJobId}" has invalid fields.` };
  }
  const snapshotValidation = validateJobSnapshot(value.snapshot, ownerSession, expectedJobId);
  if (!snapshotValidation.snapshot) {
    return { error: snapshotValidation.error ?? "Job snapshot has invalid fields." };
  }
  return { result: value as unknown as JobReadResult };
}

export function validateJobSnapshots(
  value: unknown,
  ownerSession: string,
): { jobs: JobSnapshot[]; error?: string } {
  if (!Array.isArray(value)) {
    return { jobs: [], error: "Jobs response must be an array." };
  }

  const jobs = value.filter((entry): entry is JobSnapshot => isJobSnapshot(entry, ownerSession));
  const invalidCount = value.length - jobs.length;
  if (invalidCount === 0) {
    return { jobs };
  }

  const noun = invalidCount === 1 ? "snapshot" : "snapshots";
  return { jobs, error: `Ignored ${invalidCount} invalid Job ${noun}.` };
}

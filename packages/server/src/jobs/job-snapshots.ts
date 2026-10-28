import {
  filterJobSnapshots,
  type AgentJobHost,
  type JobTarget,
  type JobKind,
  type JobReadResult,
  type JobSnapshot,
  type JobStatus,
} from "@vykor/jobs";
import type { SessionExecutionRecord } from "@vykor/domain-contracts/sessions";

const DEFAULT_OUTPUT_LIMIT = 12_000;

export function taskSnapshot(task: SessionExecutionRecord): JobSnapshot {
  return {
    id: task.id,
    kind: taskKind(task.type),
    target: taskTarget(task),
    label: task.description,
    ownerSession: task.sessionId,
    status: taskStatus(task.status),
    capabilities: {
      read: true,
      wait: true,
      send: false,
      cancel: false,
    },
    cwd: task.cwd,
    startedAt: task.startedAt ?? task.createdAt,
    updatedAt: task.updatedAt,
    ...(task.finishedAt ? { finishedAt: task.finishedAt } : {}),
    ...(task.error ? { detail: task.error } : {}),
    ...(task.status !== "pending" &&
    task.status !== "running" &&
    task.metadata.executionBackend === "detached_process" &&
    (task.metadata.processExitCode === null ||
      (typeof task.metadata.processExitCode === "number" &&
        Number.isInteger(task.metadata.processExitCode)))
      ? { exitCode: task.metadata.processExitCode as number | null }
      : {}),
    metadata: {
      ...task.metadata,
      ...(task.childSessionId ? { childSessionId: task.childSessionId } : {}),
    },
  };
}

function taskKind(type: string): JobKind {
  return type === "shell" || type === "dream" ? type : "agent";
}

function taskStatus(status: SessionExecutionRecord["status"]): JobStatus {
  if (status === "completed" || status === "failed") return status;
  if (status === "stopped" || status === "interrupted") return "killed";
  return "running";
}

export function runtimeExecutionId(task: SessionExecutionRecord): string {
  if (typeof task.metadata.runtimeExecutionId === "string")
    return task.metadata.runtimeExecutionId;
  if (typeof task.metadata.taskManagerId === "string")
    return task.metadata.taskManagerId;
  return task.id;
}

export function executionBackend(
  task: SessionExecutionRecord,
): "detached_process" | "child_agent" {
  if (task.metadata.executionBackend === "child_agent") return "child_agent";
  if (task.metadata.executionBackend === "detached_process")
    return "detached_process";
  return task.metadata.origin === "child_session"
    ? "child_agent"
    : "detached_process";
}

export function normalizeLimit(value: number | undefined): number {
  return value === undefined || !Number.isFinite(value)
    ? DEFAULT_OUTPUT_LIMIT
    : Math.max(1, Math.floor(value));
}

export function limitOutput(
  text: string,
  maxChars = DEFAULT_OUTPUT_LIMIT,
): Pick<JobReadResult, "text" | "truncated"> {
  const limit = normalizeLimit(maxChars);
  return text.length > limit
    ? { text: text.slice(-limit), truncated: true }
    : { text, truncated: false };
}

export function readChildFailure(
  task: SessionExecutionRecord,
): Record<string, unknown> | undefined {
  const value = task.metadata.childFailure;
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function taskTarget(task: SessionExecutionRecord): JobTarget {
  const kind = taskKind(task.type);
  if (kind !== "agent") return { kind, jobId: task.id };
  const runId =
    task.runId ??
    (executionBackend(task) === "detached_process"
      ? runtimeExecutionId(task)
      : undefined);
  if (!runId)
    throw new Error(`Archived agent run cannot be located: ${task.id}`);
  return { kind, jobId: task.id, runId };
}

export function createTaskArchive(
  store: Pick<import("@vykor/services").SessionStore, "conversations" | "runs">,
  sessionId: string,
  source: "agent" | "process",
): Pick<AgentJobHost, "list" | "read"> {
  const accepts = (task: SessionExecutionRecord) =>
    source === "agent"
      ? task.type === "agent"
      : task.type === "shell" || task.type === "dream";
  return {
    list: async (input) => {
      const jobs: JobSnapshot[] = [],
        errors: Array<{ kind: JobKind; message: string }> = [];
      for (const task of store.runs
        .listSessionTasks(sessionId)
        .filter(accepts)) {
        try {
          const snapshot = taskSnapshot(task);
          snapshot.capabilities = {
            read: true,
            wait: true,
            send: false,
            cancel: false,
          };
          jobs.push(snapshot);
        } catch (error) {
          errors.push({
            kind: taskKind(task.type),
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return { jobs: filterJobSnapshots(jobs, input), errors };
    },
    read: async (input) => {
      const task = store.runs.getSessionTask(input.target.jobId);
      if (!task || task.sessionId !== sessionId || !accepts(task))
        throw new Error(`Job not found: ${input.target.jobId}`);
      const snapshot = taskSnapshot(task);
      if (snapshot.kind !== input.target.kind)
        throw new Error("Archived target kind conflict");
      let output = task.output ?? task.error ?? "";
      if (
        input.target.kind === "agent" &&
        snapshot.target.kind === "agent" &&
        executionBackend(task) === "child_agent"
      ) {
        if (!task.childSessionId)
          throw new Error("Archived process target identity conflict");
        const targetRunId = input.target.runId;
        const run = store.runs.getRun(targetRunId);
        if (!run || run.sessionId !== task.childSessionId)
          throw new Error(`RUN_RESULT_NOT_RETAINED: ${targetRunId}`);
        const messages = store.conversations
          .listMessages(task.childSessionId)
          .filter(
            (message) =>
              message.runId === targetRunId && message.role === "assistant",
          );
        const messageIds = new Set(messages.map((message) => message.id));
        output = typeof run.metadata.terminalOutput === "string" ? run.metadata.terminalOutput : store.conversations
          .listMessageParts(task.childSessionId)
          .filter(
            (part) => messageIds.has(part.messageId) && part.type === "text",
          )
          .map((part) => part.text ?? "")
          .join("\n");
        if (!output && run.status !== "completed") output = run.error ?? "";
        snapshot.target = input.target;
        snapshot.startedAt = run.startedAt ?? run.createdAt;
        snapshot.updatedAt = run.updatedAt;
        if (run.finishedAt) snapshot.finishedAt = run.finishedAt;
        if (run.error) snapshot.detail = run.error; else delete snapshot.detail;
        snapshot.metadata ??= {};
        delete snapshot.metadata.childFailure;
        if (run.metadata.childFailure) snapshot.metadata.childFailure = run.metadata.childFailure;
        snapshot.status =
          run.status === "completed"
            ? "completed"
            : run.status === "failed"
              ? "failed"
              : run.status === "interrupted"
                ? "killed"
                : "running";
      }
      snapshot.capabilities = {
        read: true,
        wait: true,
        send: false,
        cancel: false,
      };
      const childFailure = snapshot.metadata?.childFailure;
      return {
        ...limitOutput(
          input.after === undefined ? output : output.slice(input.after),
          input.maxChars,
        ),
        cursor: output.length,
        snapshot,
        ...(childFailure ? { details: { childFailure } } : {}),
      };
    },
  };
}

import { createHash } from "node:crypto";
import {
  filterJobSnapshots,
  isTerminalJobStatus,
  type AgentJobHost,
  type JobSnapshot,
  type JobReadRequest,
  type JobReadResult,
  type JobWaitRequest,
} from "@vykor/jobs";
import type {
  DetachedProcessExecution,
  DetachedProcessSupervisor,
  ShellAdmissionPorts,
} from "@vykor/execution-node";
import type { AgentBackgroundShellHost } from "@vykor/tools";

export interface ProcessJobSourceOptions {
  sessionId: string;
  cwd: string;
  processes: DetachedProcessSupervisor;
  admission?: ShellAdmissionPorts;
  archive?: Pick<AgentJobHost, "list" | "read">;
}
export interface ProcessJobBindings {
  jobs: AgentJobHost;
  backgroundShell: AgentBackgroundShellHost;
}

export function processSnapshot(
  task: DetachedProcessExecution,
  sessionId: string,
): JobSnapshot {
  const kind =
    task.type === "shell" || task.type === "dream" ? task.type : "agent";
  const status =
    task.status === "stopped"
      ? "killed"
      : task.status === "pending"
        ? "running"
        : task.status;
  const updatedAt = task.finishedAt ?? task.startedAt ?? task.createdAt;
  return {
    id: task.id,
    kind,
    target:
      kind === "agent"
        ? { kind, jobId: task.id, runId: task.id }
        : { kind, jobId: task.id },
    label: task.description,
    ownerSession: sessionId,
    status,
    capabilities: {
      read: true,
      wait: true,
      send: task.type === "agent" && task.status === "running",
      cancel: !isTerminalJobStatus(status),
    },
    cwd: task.cwd,
    startedAt: task.startedAt ?? task.createdAt,
    updatedAt,
    ...(task.finishedAt ? { finishedAt: task.finishedAt } : {}),
    ...(task.processExitCode !== undefined
      ? { exitCode: task.processExitCode }
      : {}),
    metadata: { ...task.metadata },
  };
}

export function selectOutput(text: string, after?: number, maxChars = 12_000) {
  const cursor = text.length,
    unread =
      after === undefined ? text : text.slice(Math.max(0, Math.floor(after)));
  const limit = Number.isFinite(maxChars)
    ? Math.max(1, Math.floor(maxChars))
    : 12_000;
  return {
    text: unread.length > limit ? unread.slice(-limit) : unread,
    truncated: unread.length > limit,
    cursor,
  };
}

export function readProcess(
  processes: DetachedProcessSupervisor,
  task: DetachedProcessExecution,
  input: JobReadRequest,
): JobReadResult {
  const snapshot = processSnapshot(task, input.sessionId);
  try {
    return {
      ...selectOutput(
        processes.readOutput(task.id, Number.MAX_SAFE_INTEGER),
        input.after,
        input.maxChars,
      ),
      snapshot,
    };
  } catch (error) {
    if (task.metadata.outputWriteFailed !== "1") throw error;
    return {
      snapshot,
      text: "",
      cursor: input.after ?? 0,
      truncated: false,
      details: {
        outputUnavailable:
          "Background log could not be read; output may be incomplete.",
      },
    };
  }
}

export async function observeCompletion<T>(
  completion: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    void completion.catch(() => {});
    throw new Error("Job wait timeoutMs must be a positive finite number.");
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      completion.then(() => false),
      new Promise<boolean>((resolve, reject) => {
        timer = setTimeout(() => resolve(true), timeoutMs);
        abort = () => reject(signal?.reason ?? new Error("Job wait aborted"));
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (abort) signal?.removeEventListener("abort", abort);
  }
}

export function mergeJobs(
  live: JobSnapshot[],
  archived: JobSnapshot[],
): JobSnapshot[] {
  const key = (job: JobSnapshot) =>
    `${job.kind}\0${job.id}\0${job.target.kind === "agent" ? job.target.runId : ""}`;
  return [
    ...new Map([...archived, ...live].map((job) => [key(job), job])).values(),
  ];
}

export function createProcessJobSource(
  options: ProcessJobSourceOptions,
): ProcessJobBindings {
  const assertOwner = (sessionId: string) => {
    if (sessionId !== options.sessionId)
      throw new Error("Job owner session mismatch.");
  };
  const find = (input: JobReadRequest) => {
    assertOwner(input.sessionId);
    const task = options.processes.getExecution(input.target.jobId);
    if (!task) return undefined;
    const snapshot = processSnapshot(task, options.sessionId);
    if (
      snapshot.kind !== input.target.kind ||
      (input.target.kind === "agent" && input.target.runId !== task.id)
    )
      throw new Error("Process target identity conflict");
    return task;
  };
  const jobs: AgentJobHost = {
    list: async (input) => {
      assertOwner(input.sessionId);
      const live = options.processes
        .listExecutions()
        .map((task) => processSnapshot(task, options.sessionId));
      const archive = await options.archive?.list({
        ...input,
        limit: undefined,
      });
      return {
        jobs: filterJobSnapshots(mergeJobs(live, archive?.jobs ?? []), input),
        errors: archive?.errors ?? [],
      };
    },
    read: async (input) => {
      const task = find(input);
      if (task) return readProcess(options.processes, task, input);
      if (options.archive) return options.archive.read(input);
      throw new Error(`Job not found: ${input.target.jobId}`);
    },
    wait: async (input) => {
      const task = find(input);
      if (!task) {
        const result = await jobs.read(input);
        return {
          ...result,
          timedOut: !isTerminalJobStatus(result.snapshot.status),
        };
      }
      if (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0)
        throw new Error("Job wait timeoutMs must be a positive finite number.");
      const result = await options.processes.awaitExecution(task.id, {
        timeoutMs: input.timeoutMs,
        signal: input.signal,
      });
      return {
        ...(await jobs.read(input)),
        timedOut: result.timedOut === true,
      };
    },
    send: async (input) => {
      const task = find(input);
      if (!task || task.type !== "agent" || task.status !== "running")
        throw new Error(`Job ${input.target.jobId} does not accept input.`);
      await options.processes.writeInput(task.id, input.data);
    },
    cancel: async (input) => {
      const task = find(input);
      if (!task) {
        const archived = await jobs.read(input);
        if (isTerminalJobStatus(archived.snapshot.status))
          return archived.snapshot;
        throw new Error(`Job runtime unavailable: ${input.target.jobId}`);
      }
      return processSnapshot(
        await options.processes.stopExecution(task.id),
        options.sessionId,
      );
    },
  };
  return {
    jobs,
    backgroundShell: {
      create: async (input) => {
        assertOwner(input.sessionId);
        if (input.cwd !== options.cwd)
          throw new Error("Background shell cwd mismatch.");
        if (!input.requestId.trim()) throw new Error("requestId is required");
        const id = `task_${createHash("sha256").update(`${input.sessionId}\0tool\0${input.requestId}`).digest("hex").slice(0, 32)}`;
        const task = await options.processes.startShellExecution(
          {
            id,
            requestId: input.requestId,
            requestNamespace: "tool",
            command: input.command,
            description: input.description,
            cwd: input.cwd,
            sessionId: input.sessionId,
            settings: input.settings,
            executionCwd: input.executionCwd,
            shellDescriptor: input.shellDescriptor,
          },
          options.admission,
        );
        return { jobId: task.id, label: task.description };
      },
    },
  };
}

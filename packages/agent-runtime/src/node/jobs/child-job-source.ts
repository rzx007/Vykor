import type {
  AgentChildDirectory,
  AgentChildInput,
  AgentInputReceipt,
  AgentChildHandle,
  AgentChildRunSnapshot,
} from "@vykor/agent-contracts";
import type { DetachedProcessSupervisor } from "@vykor/execution-node";
import {
  filterJobSnapshots,
  isTerminalJobStatus,
  type AgentJobHost,
  type AgentJobAuthorization,
  type JobSnapshot,
  type JobReadRequest,
} from "@vykor/jobs";
import {
  createProcessJobSource,
  mergeJobs,
  selectOutput,
  observeCompletion,
} from "./process-job-source.js";

export interface ChildJobSourceOptions {
  sessionId: string;
  cwd: string;
  children: AgentChildDirectory;
  processes: DetachedProcessSupervisor;
  sendChildInput(
    childId: string,
    expectedRunId: string,
    input: AgentChildInput,
    authorization?: AgentJobAuthorization,
  ): Promise<AgentInputReceipt>;
  archive?: Pick<AgentJobHost, "list" | "read">;
}

export function createChildJobSource(
  options: ChildJobSourceOptions,
): AgentJobHost {
  const processJobs = createProcessJobSource({
    ...options,
    archive: undefined,
  }).jobs;
  const assertOwner = (sessionId: string) => {
    if (sessionId !== options.sessionId)
      throw new Error("Job owner session mismatch.");
  };
  const childFor = (input: JobReadRequest) => {
    assertOwner(input.sessionId);
    if (input.target.kind !== "agent")
      throw new Error("Child source requires an agent target");
    const child = options.children.get(input.target.jobId),
      process = options.processes.getExecution(input.target.jobId);
    if (child && process)
      throw new Error(`Job source conflict: ${input.target.jobId}`);
    return child;
  };
  const snapshot = (
    handle: AgentChildHandle,
    run: AgentChildRunSnapshot,
  ): JobSnapshot => {
    const status = run.result
      ? run.result.status === "completed"
        ? "completed"
        : run.result.status === "failed"
          ? "failed"
          : "killed"
      : run.stopping
        ? "stopping"
        : "running";
    return {
      id: handle.id,
      kind: "agent",
      target: { kind: "agent", jobId: handle.id, runId: run.receipt.runId },
      label: `Child agent ${handle.id}`,
      ownerSession: options.sessionId,
      status,
      capabilities: {
        read: true,
        wait: true,
        send:
          handle.state !== "closed" &&
          handle.state !== "closing" &&
          handle.runId === run.receipt.runId,
        cancel: !run.result,
      },
      cwd: options.cwd,
      startedAt: run.startedAt,
      updatedAt: run.updatedAt,
      ...(run.stoppedAt ? { finishedAt: run.stoppedAt } : {}),
      ...(run.result?.error ? { detail: run.result.error } : {}),
      ...(run.cleanupUnconfirmed ? { detail: run.cleanupUnconfirmed.message } : {}),
      metadata: {
        childSessionId: handle.sessionId,
        childState: handle.state,
        ...(run.result?.failureKind || run.result?.partialResult ? {
          childFailure: {
            ...(run.result.failureKind ? { failureKind: run.result.failureKind } : {}),
            ...(run.result.partialResult ? { partialResult: run.result.partialResult } : {}),
          },
        } : {}),
        ...(run.projectionError ? { projectionError: run.projectionError } : {}),
        ...(run.cleanupUnconfirmed ? { cleanupUnconfirmed: run.cleanupUnconfirmed } : {}),
      },
    };
  };
  const jobs: AgentJobHost = {
    list: async (input) => {
      assertOwner(input.sessionId);
      const live: JobSnapshot[] = options.children
        .list()
        .flatMap((child) =>
          child.runId ? [snapshot(child, child.readRun(child.runId))] : [],
        );
      const processes = await processJobs.list({
        ...input,
        kinds: ["agent"],
        limit: undefined,
      });
      for (const process of processes.jobs)
        if (options.children.get(process.id))
          throw new Error(`Job source conflict: ${process.id}`);
      const archive = await options.archive?.list({
        ...input,
        limit: undefined,
      });
      return {
        jobs: filterJobSnapshots(
          mergeJobs([...live, ...processes.jobs], archive?.jobs ?? []),
          input,
        ),
        errors: archive?.errors ?? [],
      };
    },
    read: async (input) => {
      const child = childFor(input);
      if (child && input.target.kind === "agent") {
        let run: AgentChildRunSnapshot;
        try { run = child.readRun(input.target.runId); }
        catch (error) {
          if (!(error instanceof Error) || !error.message.startsWith("RUN_RESULT_NOT_RETAINED:") || !options.archive) throw error;
          return options.archive.read(input);
        }
        return {
          ...selectOutput(
            run.result?.output || run.result?.error || "",
            input.after,
            input.maxChars,
          ),
          snapshot: snapshot(child, run),
          ...(child.activity?.runId === input.target.runId
            ? { details: { activity: child.activity } }
            : {}),
        };
      }
      if (options.processes.getExecution(input.target.jobId))
        return processJobs.read(input);
      if (options.archive) return options.archive.read(input);
      throw new Error(`Job not found: ${input.target.jobId}`);
    },
    wait: async (input) => {
      const child = childFor(input);
      if (child && input.target.kind === "agent") {
        try { child.readRun(input.target.runId); }
        catch (error) {
          if (!(error instanceof Error) || !error.message.startsWith("RUN_RESULT_NOT_RETAINED:")) throw error;
          const archived = await jobs.read(input);
          return { ...archived, timedOut: !isTerminalJobStatus(archived.snapshot.status) };
        }
        const timedOut = await observeCompletion(
          child.waitRun(input.target.runId),
          input.timeoutMs,
          input.signal,
        );
        return { ...(await jobs.read(input)), timedOut };
      }
      if (options.processes.getExecution(input.target.jobId))
        return processJobs.wait(input);
      const result = await jobs.read(input);
      return {
        ...result,
        timedOut: !isTerminalJobStatus(result.snapshot.status),
      };
    },
    send: async (input, authorization) => {
      const child = childFor(input);
      if (child && input.target.kind === "agent")
        return options.sendChildInput(
          child.id,
          input.target.runId,
          { content: input.data },
          authorization,
        );
      return processJobs.send(input, authorization);
    },
    cancel: async (input) => {
      const child = childFor(input);
      if (child && input.target.kind === "agent") {
        const run = child.readRun(input.target.runId);
        if (!run.result)
          await child.interruptRun(input.target.runId, input.reason);
        return snapshot(child, child.readRun(input.target.runId));
      }
      if (options.processes.getExecution(input.target.jobId))
        return processJobs.cancel(input);
      const archived = await jobs.read(input);
      if (isTerminalJobStatus(archived.snapshot.status))
        return archived.snapshot;
      throw new Error(`Job runtime unavailable: ${input.target.jobId}`);
    },
  };
  return jobs;
}

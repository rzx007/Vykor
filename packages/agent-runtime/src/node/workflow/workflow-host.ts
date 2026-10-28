import type { ToolResult } from "@vykor/agent-contracts";
import {
  createWorkflowPlan,
  createWorkflowRunId,
  createWorkflowRunSnapshot,
  createWorkflowResultFromSnapshot,
  runWorkflow,
  createWorkflowNotification,
  formatWorkflowNotification,
  asOptionalString,
  parseAction,
  parseWorkflowSpec,
  secondsToOptionalMs,
  parsePermissionMode,
  type WorkflowRunRepository,
  type WorkflowRunSnapshot,
  type WorkflowRunResult,
  type WorkflowRunEvent,
  type WorkflowSpec,
  type WorkflowRunner,
  type WorkflowTaskRunResult,
} from "@vykor/coordinator/workflow";
import type { AgentJobHost, JobSnapshot, JobReadResult } from "@vykor/jobs";
import { filterJobSnapshots, isTerminalJobStatus } from "@vykor/jobs";

import type { WorkflowInvocation, WorkflowToolPort } from "@vykor/tools";
import type { ExecutionRuntimeOwner } from "@vykor/execution-node";
import {
  getAgentDefinition,
  type AgentDefinition,
} from "@vykor/coordinator/definitions";
import {
  createAgentWorkflowRunner,
  type AgentWorkflowRunnerOptions,
} from "./agent-workflow-runner.js";
import { MemoryWorkflowRunRepository } from "./memory-workflow-run-repository.js";
import {
  workflowValidate,
  workflowTimeline,
  workflowHistory,
  workflowTemplate,
  workflowReconcile,
  loadWorkflowSnapshot,
} from "./workflow-actions.js";

export interface WorkflowRunOwner {
  cwd: string;
  sessionId: string;
}
export interface PersistentWorkflowOptions {
  stopTask?: (taskId: string, reason?: string, runId?: string) => Promise<unknown>;
  runId?: string;
  ownerSession?: string;
  ownerInput?: string;
  ownerRun?: string;
  signal?: AbortSignal;
  onEvent?: (event: WorkflowRunEvent) => void;
}
export interface WorkflowBindingOptions extends WorkflowRunOwner {
  children?: import("@vykor/agent-contracts").AgentChildDirectory;
  stopTask?: (taskId: string, reason?: string, runId?: string) => Promise<unknown>;
  executionOwner?: ExecutionRuntimeOwner;
  definitions?: readonly AgentDefinition[];
  createRunner?: (options: AgentWorkflowRunnerOptions) => WorkflowRunner;
}
export interface BoundWorkflowHost extends WorkflowToolPort {
  readonly jobs: AgentJobHost;
  close(reason?: string): Promise<void>;
}
interface ActiveRun {
  snapshot: WorkflowRunSnapshot;
  stopTask?: PersistentWorkflowOptions["stopTask"];
  repository: WorkflowRunRepository;
  ownerSession?: string;
  stopReason?: string;
  abort: AbortController;
  done: Promise<WorkflowRunResult>;
  cancellation?: Promise<WorkflowRunResult>;
}

/** One application's live workflow directory. Repository identity is storage, not execution ownership. */
export class WorkflowHost {
  private readonly active = new Map<string, ActiveRun>();
  private readonly abort = new AbortController();
  private closing?: Promise<void>;
  constructor(readonly repository: WorkflowRunRepository) {}

  runPersistentWorkflow(
    spec: WorkflowSpec,
    runner: WorkflowRunner,
    options: PersistentWorkflowOptions = {},
  ): Promise<WorkflowRunResult> {
    const runId = options.runId ?? createWorkflowRunId();
    if (this.repository.load(runId))
      throw new Error(`Workflow run already exists: ${runId}`);
    return this.start(spec, runner, { ...options, runId });
  }

  resumePersistentWorkflow(
    snapshotOrId: WorkflowRunSnapshot | string,
    runner: WorkflowRunner,
    options: PersistentWorkflowOptions = {},
  ): Promise<WorkflowRunResult> {
    const snapshot =
      typeof snapshotOrId === "string"
        ? this.repository.load(snapshotOrId)
        : snapshotOrId;
    if (!snapshot) throw new Error(`Workflow run not found: ${snapshotOrId}`);
    if (snapshot.status !== "running")
      return Promise.resolve(createWorkflowResultFromSnapshot(snapshot));
    return this.start(
      snapshot.spec,
      runner,
      {
        ...options,
        runId: snapshot.runId,
        ownerSession: snapshot.ownerSession,
        ownerInput: snapshot.ownerInput,
        ownerRun: snapshot.ownerRun,
      },
      snapshot,
    );
  }

  private start(
    spec: WorkflowSpec,
    runner: WorkflowRunner,
    options: PersistentWorkflowOptions & { runId: string },
    previous?: WorkflowRunSnapshot,
    repository = this.repository,
  ): Promise<WorkflowRunResult> {
    if (this.abort.signal.aborted) throw new Error("Workflow host is closed.");
    if (options.signal?.aborted)
      throw options.signal.reason ?? new Error("Workflow owner interrupted.");
    if (this.active.has(options.runId))
      throw new Error(`Workflow run already active: ${options.runId}`);
    // Validate and save before dispatch: scheduler callbacks intentionally tolerate observer errors.
    const plan = createWorkflowPlan(spec);
    const initial =
      previous ??
      createWorkflowRunSnapshot({
        runId: options.runId,
        ownerSession: options.ownerSession,
        ownerInput: options.ownerInput,
        ownerRun: options.ownerRun,
        status: "running",
        summary: "Workflow started",
        spec,
        plan,
        results: new Map(),
        running: new Set(),
        runningTasks: new Map(),
        blockedTasks: new Map(),
        createdAt: Date.now(),
      });
    repository.save(initial);
    repository.claim(options.runId);
    let resolve!: (result: WorkflowRunResult) => void;
    let reject!: (error: unknown) => void;
    const done = new Promise<WorkflowRunResult>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const active: ActiveRun = {
      snapshot: initial,
      repository,
      stopTask: options.stopTask,
      ownerSession: options.ownerSession,
      abort: new AbortController(),
      done,
    };
    this.active.set(options.runId, active);
    let persistenceError: unknown;
    const persist = (work: () => void) => {
      if (active.stopReason) return;
      try {
        work();
      } catch (error) {
        persistenceError ??= error;
        active.stopReason = "Workflow persistence failed";
        active.abort.abort(error);
      }
    };
    const ownerInterrupted = () => {
      void this.cancelPersistentWorkflow(options.runId, {
        reason: "Parent session interrupted",
      }).catch(() => undefined);
    };
    options.signal?.addEventListener("abort", ownerInterrupted, { once: true });
    if (options.signal?.aborted) ownerInterrupted();
    let initialSnapshotEmitted = false;
    const work = runWorkflow(
      spec,
      async (call) => {
        const signal = AbortSignal.any([
          active.abort.signal,
          call.signal ?? active.abort.signal,
        ]);
        signal.throwIfAborted();
        return await runner({ ...call, signal });
      },
      {
        runId: options.runId,
        ownerSession: options.ownerSession,
        ownerInput: options.ownerInput,
        ownerRun: options.ownerRun,
        createdAt: initial.createdAt,
        initialResults: previous?.results,
        initialRunningTasks: previous?.runningTasks,
        shouldStop: () => active.stopReason,
        onSnapshot: (snapshot) => {
          // Admission already saved the initial snapshot synchronously. Keep
          // one durable write/event for that transition before workers start.
          if (!initialSnapshotEmitted) { initialSnapshotEmitted = true; return; }
          persist(() => {
            repository.save(snapshot);
            active.snapshot = snapshot;
            if (snapshot.status !== "running" && !hasUnconfirmedWorker(snapshot))
              repository.finish(snapshot.runId, snapshot.status);
          });
        },
        onEvent: (event) => {
          persist(() => repository.appendEvent(event));
          if (!active.stopReason)
            try {
              options.onEvent?.(event);
            } catch {
              /* Optional observers do not own persistence. */
            }
        },
      },
    );
    const cleanup = () => {
      options.signal?.removeEventListener("abort", ownerInterrupted);
      // Cancellation keeps ownership until its terminal write has finished.
      if (!active.cancellation && !hasUnconfirmedWorker(active.snapshot)) this.active.delete(options.runId);
    };
    void work.then(
      (result) => {
        cleanup();
        if (persistenceError) reject(persistenceError);
        else resolve(result);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
    // The host owns detached failures; waiting callers still receive the original rejection.
    void done.catch(() => undefined);
    return done;
  }

  cancelPersistentWorkflow(
    snapshotOrId: WorkflowRunSnapshot | string,
    options: {
      reason?: string;
      stopTask?: (taskId: string, reason?: string, runId?: string) => Promise<unknown>;
      onEvent?: (event: WorkflowRunEvent) => void;
    } = {},
  ): Promise<WorkflowRunResult> {
    const runId =
      typeof snapshotOrId === "string" ? snapshotOrId : snapshotOrId.runId;
    const active = this.active.get(runId);
    if (active?.cancellation) {
      // A repeated explicit cancel may confirm the original failed cleanup.
      // Keep the original cancellation waiter and fixed worker/run identities.
      const stopTask = options.stopTask ?? active.stopTask;
      if (stopTask) for (const task of [...Object.values(active.snapshot.runningTasks), ...Object.values(active.snapshot.results).filter(result => result.cleanupUnconfirmed || result.metadata?.cleanupUnconfirmed)]) {
        const id = task.metadata?.workerTaskId;
        const runId = task.metadata?.workerRunId;
        if (typeof id === "string") void stopTask(id, options.reason ?? active.stopReason, typeof runId === "string" ? runId : undefined).catch(() => {});
      }
      return active.cancellation;
    }
    let snapshot: WorkflowRunSnapshot | undefined;
    try {
      snapshot = (active?.repository ?? this.repository).load(runId) ?? active?.snapshot;
    } catch (error) {
      if (!active) throw error;
      active.stopReason = "Workflow repository unreadable";
      active.abort.abort(error);
      return active.done.then(() => { throw error; }, () => { throw error; });
    }
    if (!snapshot) throw new Error(`Workflow run not found: ${runId}`);
    if (snapshot.status !== "running" && !active)
      return Promise.resolve(createWorkflowResultFromSnapshot(snapshot));
    const reason = options.reason ?? "Workflow cancelled";
    if (active) {
      active.stopReason = reason;
      active.abort.abort(new Error(reason));
    }
    const cancellation = this.finishCancellation(snapshot, active, reason, {
      ...options,
      stopTask: options.stopTask ?? active?.stopTask,
    });
    if (active) active.cancellation = cancellation;
    return cancellation;
  }

  private async finishCancellation(
    snapshot: WorkflowRunSnapshot,
    active: ActiveRun | undefined,
    reason: string,
    options: {
      stopTask?: (taskId: string, reason?: string, runId?: string) => Promise<unknown>;
      onEvent?: (event: WorkflowRunEvent) => void;
    },
  ): Promise<WorkflowRunResult> {
    const stops = [...Object.values(snapshot.runningTasks), ...Object.values(snapshot.results).filter(result => result.cleanupUnconfirmed || result.metadata?.cleanupUnconfirmed)].map(async (task) => {
      const id = task.metadata?.workerTaskId;
      const uncertain = "cleanupUnconfirmed" in task && task.cleanupUnconfirmed || task.metadata?.cleanupUnconfirmed;
      if (uncertain && (typeof id !== "string" || !options.stopTask)) throw new Error("Workflow worker stop cannot be confirmed without its original receipt and stop port");
      if (typeof id === "string" && options.stopTask)
        await options.stopTask(id, reason, typeof task.metadata?.workerRunId === "string" ? task.metadata.workerRunId : undefined);
    });
    const settled = await Promise.allSettled([
      ...stops,
      ...(active ? [active.done] : []),
    ]);
    const failure = settled.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    const plan = createWorkflowPlan(snapshot.spec);
    const results = new Map<string, WorkflowTaskRunResult>(
      Object.entries(snapshot.results),
    );
    for (const [id, result] of results) if (result.cleanupUnconfirmed || result.metadata?.cleanupUnconfirmed) {
      const { cleanupUnconfirmed: _uncertain, ...confirmed } = result;
      const { cleanupUnconfirmed: _diagnostic, stopping: _stopping, ...metadata } = result.metadata ?? {};
      results.set(id, { ...confirmed, metadata });
    }
    const now = Date.now();
    for (const taskId of plan.executionOrder) {
      if (results.has(taskId)) continue;
      const running = snapshot.runningTasks[taskId];
      results.set(taskId, {
        taskId,
        status: running ? "killed" : "skipped",
        summary: reason,
        attempts: running?.attempt ?? 0,
        dependencies: [...(plan.dependencyMap[taskId] ?? [])],
        startedAt: running?.startedAt ?? now,
        finishedAt: now,
        ...(running
          ? { metadata: { ...running.metadata, cancelled: true } }
          : { skippedReason: reason }),
      });
    }
    const cancelled = createWorkflowRunSnapshot({
      runId: snapshot.runId,
      ownerSession: snapshot.ownerSession,
      ownerInput: snapshot.ownerInput,
      ownerRun: snapshot.ownerRun,
      status: "failed",
      termination: "cancelled",
      summary: reason,
      spec: snapshot.spec,
      plan,
      results,
      running: new Set(),
      runningTasks: new Map(),
      blockedTasks: new Map(),
      createdAt: snapshot.createdAt,
    });
    const repository = active?.repository ?? this.repository;
    repository.save(cancelled);
    repository.finish(snapshot.runId, cancelled.status);
    const event: WorkflowRunEvent = {
      version: 1,
      runId: snapshot.runId,
      type: "workflow_cancelled",
      timestamp: now,
      status: "failed",
      summary: reason,
    };
    repository.appendEvent(event);
    options.onEvent?.(event);
    this.active.delete(snapshot.runId);
    return createWorkflowResultFromSnapshot(cancelled);
  }

  bind(options: WorkflowBindingOptions): BoundWorkflowHost {
    let closed = false;
    let closing: Promise<void> | undefined;
    const assertOwner = (sessionId: string) => {
      if (closed) throw new Error("Workflow owner is closed.");
      if (sessionId !== options.sessionId)
        throw new Error("Workflow owner session mismatch.");
    };
    const owned = (id: string) => {
      const runId = id;
      const snapshot = this.repository.load(runId);
      if (!snapshot || snapshot.ownerSession !== options.sessionId)
        throw new Error(`Workflow run not found: ${runId}`);
      return snapshot;
    };
    const jobSnapshot = (run: WorkflowRunSnapshot): JobSnapshot => ({
      id: run.runId,
      kind: "workflow",
      target: { kind: "workflow", jobId: run.runId },
      label: run.summary,
      ownerSession: options.sessionId,
      status:
        hasUnconfirmedWorker(run) ? "stopping" : run.status === "running"
          ? (this.active.get(run.runId)?.stopReason || Object.values(run.runningTasks).some(task => task.metadata?.stopping || task.metadata?.cleanupUnconfirmed) ? "stopping" : "running")
          : run.termination === "cancelled"
            ? "killed"
            : run.status,
      capabilities: {
        read: true,
        wait: true,
        send: false,
        cancel: run.status === "running" || hasUnconfirmedWorker(run),
      },
      cwd: options.cwd,
      startedAt: run.createdAt,
      updatedAt: run.updatedAt,
      ...(run.status !== "running" && !hasUnconfirmedWorker(run) ? { finishedAt: run.updatedAt } : {}),
      metadata: {
        mode: run.plan.mode,
        totalTasks: run.plan.tasks.length,
        runningTasks: run.runningTaskIds.length,
        pendingTasks: run.pendingTaskIds.length,
      },
    });
    const read: AgentJobHost["read"] = async (input) => {
      assertOwner(input.sessionId);
      const run = owned(input.target.jobId);
      const snapshot = jobSnapshot(run);
      const output =
        input.after !== undefined && input.after >= run.updatedAt
          ? ""
          : JSON.stringify(
              {
                summary: run.summary,
                status: run.status,
                pendingTaskIds: run.pendingTaskIds,
                runningTaskIds: run.runningTaskIds,
                results: run.orderedResults,
              },
              null,
              2,
            );
      const max = input.maxChars ?? 12_000;
      const notification = createWorkflowNotification(
        createWorkflowResultFromSnapshot(run),
      );
      return {
        snapshot,
        text: output.slice(-Math.max(1, max)),
        cursor: run.updatedAt,
        truncated: output.length > max,
        details: {
          ...run,
          needsReconciliation: notification.needsReconciliation,
          reconciliationIssues: notification.reconciliationIssues,
          reconciliationSummary: notification.reconciliationSummary,
          reconciliationPlan: notification.reconciliationPlan,
        },
      };
    };
    const jobs: AgentJobHost = {
      list: async (input) => {
        assertOwner(input.sessionId);
        return { jobs: filterJobSnapshots(
          this.repository
            .list()
            .filter((run) => run.ownerSession === options.sessionId)
            .map(jobSnapshot),
          input,
        ), errors: [] };
      },
      read,
      wait: async (input) => {
        assertOwner(input.sessionId);
        if (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0)
          throw new Error(
            "Job wait timeoutMs must be a positive finite number.",
          );
        const until = Date.now() + input.timeoutMs;
        let result: JobReadResult = await read(input);
        while (
          !isTerminalJobStatus(result.snapshot.status) &&
          Date.now() < until
        ) {
          await this.repository.waitForChange(
            input.target.jobId,
            result.snapshot.updatedAt,
            { timeoutMs: until - Date.now(), signal: input.signal },
          );
          result = await read(input);
        }
        return {
          ...result,
          timedOut: !isTerminalJobStatus(result.snapshot.status),
        };
      },
      send: async (input) => {
        assertOwner(input.sessionId);
        owned(input.target.jobId);
        throw new Error(`Workflow ${input.target.jobId} does not accept input.`);
      },
      cancel: async (input) => {
        assertOwner(input.sessionId);
        owned(input.target.jobId);
        await this.cancelPersistentWorkflow(input.target.jobId, {
          reason: input.reason,
          stopTask: options.stopTask,
        });
        return jobSnapshot(owned(input.target.jobId));
      },
    };
    return {
      jobs,
      invoke: async (call) => {
        assertOwner(call.scope.sessionId);
        if (call.scope.cwd !== options.cwd)
          throw new Error("Workflow owner cwd mismatch.");
        return this.invoke(call, options);
      },
      close: (reason) => {
        if (closing) return closing;
        closed = true;
        closing = Promise.resolve().then(() =>
          this.closeOwner(options.sessionId, reason),
        );
        return closing;
      },
    };
  }

  private async invoke(
    call: WorkflowInvocation,
    options: WorkflowBindingOptions,
  ): Promise<ToolResult> {
    const { input, scope } = call;
    call.signal.throwIfAborted();
    const action = parseAction(input.action);
    if (action === "validate") return workflowValidate(input);
    if (action === "timeline")
      return workflowTimeline(input, this.repository, scope.sessionId);
    if (action === "history")
      return workflowHistory(input, this.repository, scope.sessionId);
    if (action === "template") return workflowTemplate(input);
    if (action === "reconcile")
      return workflowReconcile(input, this.repository, scope.sessionId);
    if (action !== "run" && action !== "resume")
      return toolError("Invalid workflow action");
    const spec = parseWorkflowSpec(input);
    if (action === "run" && typeof spec === "string") return toolError(spec);
    const timeoutMs = secondsToOptionalMs(input.timeoutSeconds);
    if (timeoutMs === "invalid")
      return toolError("timeoutSeconds must be a positive number");
    try {
      const existing =
        action === "resume"
          ? loadWorkflowSnapshot(this.repository, input, scope.sessionId)
          : undefined;
      if (typeof existing === "string") return toolError(existing);
      const definitions = call.definitions ?? options.definitions ?? [];
      const selectedSpec = existing?.spec ?? spec;
      if (typeof selectedSpec === "string") return toolError(selectedSpec);
      // The per-worker limit caps the task override/default. Persist that
      // effective limit so the coordinator owns the only attempt deadline,
      // including when a later invocation resumes the saved workflow.
      const executionSpec: WorkflowSpec = timeoutMs === undefined ? selectedSpec : {
        ...selectedSpec,
        tasks: selectedSpec.tasks.map(task => ({
          ...task,
          timeoutMs: Math.min(timeoutMs, task.timeoutMs ?? selectedSpec.defaultTaskTimeoutMs ?? timeoutMs),
        })),
      };
      if (call.definitions)
        for (const task of executionSpec.tasks) {
          const name = task.subagentType ?? "worker";
          if (!getAgentDefinition(name, definitions))
            return toolError(`Agent is not available in this run: ${name}`);
        }
      const runner = (options.createRunner ?? createAgentWorkflowRunner)({
        cwd: scope.cwd,
        sessionId: scope.sessionId,
        children: options.children,
        agent: call.children ? { children: call.children } : undefined,
        team: asOptionalString(input.team),
        permissionMode: parsePermissionMode(input.permissionMode),
        getAgentDefinition: (name) => getAgentDefinition(name, definitions),
      });
      const runOptions = {
        runId: asOptionalString(input.runId),
        ownerSession: scope.sessionId,
        ownerInput: scope.inputId,
        ownerRun: scope.runId,
        signal: scope.signal,
        stopTask:
          options.stopTask ??
          (call.children
            ? async (id: string, reason?: string, runId?: string) => {
                const child = options.children?.get(id);
                if (child) {
                  if (!runId) {
                    if (!child.runId) { await child.close(); return; }
                    throw new Error("Workflow worker run identity is unavailable");
                  }
                  await child.interruptRun(runId, reason);
                  await child.waitRun(runId);
                  return;
                }
                throw new Error(`Workflow worker handle is unavailable: ${id}`);
              }
            : undefined),
      };
      const id = existing?.runId ?? runOptions.runId ?? createWorkflowRunId();
      const work = existing
        ? this.resumePersistentWorkflow(
            existing.status === "running" && executionSpec !== selectedSpec
              ? { ...existing, spec: executionSpec, plan: createWorkflowPlan(executionSpec) }
              : existing,
            runner,
            runOptions,
          )
        : input.persist === false
          ? this.start(
              executionSpec,
              runner,
              { ...runOptions, runId: id },
              undefined,
              new MemoryWorkflowRunRepository(),
            )
          : this.runPersistentWorkflow(executionSpec, runner, {
              ...runOptions,
              runId: id,
            });
      if (action === "resume" || input.waitForCompletion === true || input.persist === false) {
        const result = await waitForRequest(work, call.signal);
        return {
          content: [{ type: "text", text: formatWorkflowNotification(result) }],
          ...(result.status === "failed" ? { isError: true } : {}),
        };
      }
      const snapshot = this.repository.load(id)!;
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              kind: "job",
              action: "created",
              jobId: id,
              target: { kind: "workflow", jobId: id },
              jobKind: "workflow",
              label: snapshot.summary,
              status: snapshot.status,
            }),
          },
        ],
      };
    } catch (error) {
      return toolError(error instanceof Error ? error.message : String(error));
    }
  }

  private async closeOwner(
    sessionId: string,
    reason = "Workflow owner closed",
  ): Promise<void> {
    const settled = await Promise.allSettled(
      [...this.active]
        .filter(([, run]) => run.ownerSession === sessionId)
        .map(([id]) => this.cancelPersistentWorkflow(id, { reason })),
    );
    const errors = settled.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length)
      throw new AggregateError(errors, "Workflow shutdown failed");
  }
  close(reason = "Workflow host closed"): Promise<void> {
    if (this.closing) return this.closing;
    this.abort.abort(new Error(reason));
    this.closing = (async () => {
      const settled = await Promise.allSettled(
        [...this.active.keys()].map((id) =>
          this.cancelPersistentWorkflow(id, { reason }),
        ),
      );
      const errors = settled.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (errors.length)
        throw new AggregateError(errors, "Workflow shutdown failed");
    })();
    return this.closing;
  }
}
function toolError(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}
async function waitForRequest<T>(
  work: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  let aborted: () => void = () => {};
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        aborted = () =>
          reject(signal.reason ?? new Error("Workflow wait aborted"));
        signal.addEventListener("abort", aborted, { once: true });
        if (signal.aborted) aborted();
      }),
    ]);
  } finally {
    signal.removeEventListener("abort", aborted);
  }
}

function hasUnconfirmedWorker(snapshot: WorkflowRunSnapshot): boolean {
  return Object.values(snapshot.results).some(result => result.cleanupUnconfirmed || result.metadata?.cleanupUnconfirmed);
}

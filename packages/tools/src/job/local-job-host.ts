import { createHash, randomUUID } from "node:crypto";

import type {
  AgentBackgroundShellHost,
  AgentChildDirectory,
  AgentChildHandle,
  AgentChildResult,
} from "@openharness/core";
import {
  cancelPersistentWorkflow,
  createWorkflowNotification,
  createWorkflowResultFromSnapshot,
  type WorkflowRunRepository,
  type WorkflowRunSnapshot,
} from "@openharness/coordinator";
import {
  filterJobSnapshots,
  isTerminalJobStatus,
  type AgentJobHost,
  type JobCancelRequest,
  type JobKind,
  type JobListRequest,
  type JobReadRequest,
  type JobReadResult,
  type JobSnapshot,
  type JobStatus,
  type JobWaitRequest,
  type JobWaitResult,
} from "@openharness/jobs";
import {
  getDetachedProcessSupervisor,
  type DetachedProcessExecution,
  type DetachedProcessSupervisor,
} from "@openharness/services/executions";

const DEFAULT_OUTPUT_LIMIT = 12_000;
const POLL_INTERVAL_MS = 50;
const SHELL_REQUEST_RETENTION_MS = 10 * 60_000;
const MAX_SETTLED_SHELL_REQUESTS = 1_000;

interface ChildObservation {
  handle: AgentChildHandle;
  startedAt: number;
  updatedAt: number;
  result?: AgentChildResult;
  resultPromise?: Promise<AgentChildResult>;
}

type LocalJobSource =
  | { kind: "child"; value: ChildObservation }
  | { kind: "task"; value: DetachedProcessExecution }
  | { kind: "workflow"; value: WorkflowRunSnapshot };

export interface LocalAgentJobHostOptions {
  cwd: string;
  sessionId: string;
  childManager: AgentChildDirectory;
  workflowRepository?: WorkflowRunRepository;
}

/** Local Jobs controller used when a runtime has no durable host. */
export class LocalAgentJobHost implements AgentJobHost, AgentBackgroundShellHost {
  private readonly processes: DetachedProcessSupervisor;
  private readonly cwd: string;
  private readonly ownerSession: string;
  private readonly children: AgentChildDirectory;
  private readonly workflows: WorkflowRunRepository | undefined;
  private readonly childObservations = new Map<string, ChildObservation>();
  private readonly shellRequests = new Map<string, {
    fingerprint: string;
    result: Promise<{ jobId: string; label: string }>;
    createdAt: number;
    settledAt?: number;
  }>();

  constructor(options: LocalAgentJobHostOptions) {
    this.cwd = options.cwd;
    this.ownerSession = options.sessionId;
    this.children = options.childManager;
    this.workflows = options.workflowRepository;
    this.processes = getDetachedProcessSupervisor({
      cwd: options.cwd,
      sessionId: options.sessionId,
    });
  }

  async create(input: Parameters<AgentBackgroundShellHost["create"]>[0]): Promise<{ jobId: string; label: string }> {
    this.assertOwner(input.sessionId);
    if (input.cwd !== this.cwd) throw new Error("Background shell cwd mismatch.");
    this.pruneShellRequests();
    const fingerprint = createHash("sha256").update(stableJson({
      cwd: input.cwd,
      command: input.command,
      description: input.description,
      settings: input.settings,
    })).digest("hex");
    const existing = this.shellRequests.get(input.requestId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new Error(`Background shell request identity conflict: ${input.requestId}`);
      }
      return await existing.result;
    }
    const jobId = `task_${randomUUID()}`;
    const result = this.processes.startShellExecution({
      id: jobId,
      command: input.command,
      description: input.description,
      cwd: input.cwd,
      sessionId: input.sessionId,
      settings: input.settings,
    }).then((execution) => ({ jobId: execution.id, label: execution.description }));
    const entry = { fingerprint, result, createdAt: Date.now(), settledAt: undefined as number | undefined };
    this.shellRequests.set(input.requestId, entry);
    void result.then(
      () => {
        entry.settledAt = Date.now();
        this.pruneShellRequests();
      },
      () => {
        entry.settledAt = Date.now();
        this.pruneShellRequests();
      },
    );
    return await result;
  }

  private pruneShellRequests(): void {
    const cutoff = Date.now() - SHELL_REQUEST_RETENTION_MS;
    for (const [requestId, entry] of this.shellRequests) {
      if (entry.settledAt !== undefined && entry.settledAt < cutoff) {
        this.shellRequests.delete(requestId);
      }
    }
    const settled = [...this.shellRequests.entries()]
      .filter(([, entry]) => entry.settledAt !== undefined)
      .sort((left, right) => left[1].settledAt! - right[1].settledAt!);
    for (let index = 0; index < settled.length - MAX_SETTLED_SHELL_REQUESTS; index += 1) {
      this.shellRequests.delete(settled[index]![0]);
    }
  }

  async list(input: JobListRequest): Promise<JobSnapshot[]> {
    this.assertOwner(input.sessionId);
    for (const child of this.children.list()) this.observeChild(child);
    await Promise.resolve();
    const workflows = this.workflows?.list()
      .filter((workflow) => workflow.ownerSession === this.ownerSession) ?? [];
    return filterJobSnapshots([
      ...[...this.childObservations.values()].map((child) => this.childSnapshot(child)),
      ...this.processes.listExecutions().map((task) => this.taskSnapshot(task)),
      ...workflows.map((workflow) => this.workflowSnapshot(workflow)),
    ], input);
  }

  async read(input: JobReadRequest): Promise<JobReadResult> {
    this.assertOwner(input.sessionId);
    const source = this.resolve(input.jobId);
    if (source.kind === "child") {
      this.observeChild(source.value.handle);
      await Promise.resolve();
      const output = source.value.result?.output ?? source.value.result?.error ?? "";
      const selected = selectOutput(output, input.after, input.maxChars);
      return { ...selected, snapshot: this.childSnapshot(source.value) };
    }
    if (source.kind === "task") {
      const output = this.processes.readOutput(source.value.id, Number.MAX_SAFE_INTEGER);
      const selected = selectOutput(output, input.after, input.maxChars);
      return { ...selected, snapshot: this.taskSnapshot(source.value) };
    }
    const snapshot = this.workflowSnapshot(source.value);
    const output = input.after !== undefined && input.after >= snapshot.updatedAt
      ? ""
      : formatWorkflowOutput(source.value);
    const limited = limitOutput(output, input.maxChars);
    return {
      ...limited,
      cursor: snapshot.updatedAt,
      snapshot,
      details: workflowDetails(source.value),
    };
  }

  async wait(input: JobWaitRequest): Promise<JobWaitResult> {
    this.assertOwner(input.sessionId);
    if (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0) {
      throw new Error("Job wait timeoutMs must be a positive finite number.");
    }
    const deadline = Date.now() + input.timeoutMs;
    let current = await this.read(input);
    if (isTerminalJobStatus(current.snapshot.status)) return { ...current, timedOut: false };
    while (Date.now() < deadline) {
      await delay(Math.min(POLL_INTERVAL_MS, deadline - Date.now()), input.signal);
      current = await this.read(input);
      if (isTerminalJobStatus(current.snapshot.status)) return { ...current, timedOut: false };
    }
    return { ...current, timedOut: true };
  }

  async send(input: { sessionId: string; jobId: string; data: string }, authorization?: Parameters<AgentJobHost["send"]>[1]): Promise<void> {
    this.assertOwner(input.sessionId);
    const source = this.resolve(input.jobId);
    if (source.kind === "child") {
      if (!source.value.handle || source.value.handle.state === "closing" || source.value.handle.state === "closed") {
        throw new Error(`Job ${input.jobId} does not accept input.`);
      }
      if (authorization) await source.value.handle.send({ content: input.data }, authorization);
      else await source.value.handle.send({ content: input.data });
      this.observeChild(source.value.handle);
      return;
    }
    if (source.kind === "task" && taskAcceptsInput(source.value)) {
      await this.processes.writeInput(source.value.id, input.data);
      return;
    }
    throw new Error(`Job ${input.jobId} does not accept input.`);
  }

  async cancel(input: JobCancelRequest): Promise<JobSnapshot> {
    this.assertOwner(input.sessionId);
    const source = this.resolve(input.jobId);
    if (source.kind === "child") {
      await source.value.handle.interrupt(input.reason);
      await source.value.resultPromise?.catch(() => undefined);
      return this.childSnapshot(source.value);
    }
    if (source.kind === "task") {
      return this.taskSnapshot(await this.processes.stopExecution(source.value.id));
    }
    const workflows = this.workflows;
    if (!workflows) throw new Error(`Job not found: ${input.jobId}`);
    await cancelPersistentWorkflow(source.value, {
      store: workflows,
      reason: input.reason,
      stopTask: async (taskId) => await this.stopWorkflowWorker(taskId, input.reason),
    });
    return this.workflowSnapshot(workflows.load(source.value.runId)!);
  }

  /** Stop a Workflow worker whether it is a live child Agent or a detached process. */
  private async stopWorkflowWorker(taskId: string, reason?: string): Promise<unknown> {
    const child = this.children.get(taskId);
    if (child) {
      await child.interrupt(reason);
      await this.observeChild(child).resultPromise?.catch(() => undefined);
      return;
    }
    return this.processes.stopExecution(taskId);
  }

  private resolve(jobId: string): LocalJobSource {
    const liveChild = this.children.get(jobId);
    if (liveChild) return { kind: "child", value: this.observeChild(liveChild) };
    const observedChild = this.childObservations.get(jobId);
    if (observedChild) return { kind: "child", value: observedChild };
    const task = this.processes.getExecution(jobId);
    if (task) return { kind: "task", value: task };
    const workflow = this.workflows?.load(jobId);
    if (workflow?.ownerSession === this.ownerSession) return { kind: "workflow", value: workflow };
    throw new Error(`Job not found: ${jobId}`);
  }

  private observeChild(handle: AgentChildHandle): ChildObservation {
    const now = Date.now();
    let observation = this.childObservations.get(handle.id);
    if (!observation) {
      observation = { handle, startedAt: now, updatedAt: now };
      this.childObservations.set(handle.id, observation);
    } else {
      observation.handle = handle;
    }
    if (observation.resultPromise !== handle.result) {
      observation.result = undefined;
      observation.resultPromise = handle.result;
      observation.updatedAt = now;
      void handle.result.then((result) => {
        if (observation?.resultPromise !== handle.result) return;
        observation.result = result;
        observation.updatedAt = Date.now();
      }, (error) => {
        if (observation?.resultPromise !== handle.result) return;
        const message = error instanceof Error ? error.message : String(error);
        observation.result = { status: "failed", output: message, error: message };
        observation.updatedAt = Date.now();
      });
    }
    return observation;
  }

  private childSnapshot(child: ChildObservation): JobSnapshot {
    const status = childStatus(child);
    const acceptsInput = child.handle.state !== "closing" && child.handle.state !== "closed";
    return {
      id: child.handle.id,
      kind: "agent",
      label: `Child agent ${child.handle.id}`,
      ownerSession: this.ownerSession,
      status,
      capabilities: {
        read: true,
        wait: true,
        send: acceptsInput,
        cancel: acceptsInput,
      },
      cwd: this.cwd,
      startedAt: child.startedAt,
      updatedAt: child.updatedAt,
      ...(isTerminalJobStatus(status) ? { finishedAt: child.updatedAt } : {}),
      ...(child.result?.error ? { detail: child.result.error } : {}),
      metadata: {
        childSessionId: child.handle.sessionId,
        childState: child.handle.state,
        ...(child.result ? { failureKind: child.result.status } : {}),
      },
    };
  }

  private taskSnapshot(task: DetachedProcessExecution): JobSnapshot {
    const status = taskStatus(task.status);
    const updatedAt = task.finishedAt ?? task.startedAt ?? task.createdAt;
    return {
      id: task.id,
      kind: taskKind(task.type),
      label: task.description,
      ownerSession: this.ownerSession,
      status,
      capabilities: {
        read: true,
        wait: true,
        send: taskAcceptsInput(task),
        cancel: task.status === "pending" || task.status === "running",
      },
      cwd: task.cwd,
      startedAt: task.startedAt ?? task.createdAt,
      updatedAt,
      ...(task.finishedAt ? { finishedAt: task.finishedAt } : {}),
      ...(task.exitCode !== undefined ? { detail: `exit code: ${task.exitCode}` } : {}),
      metadata: { ...task.metadata },
    };
  }

  private workflowSnapshot(workflow: WorkflowRunSnapshot): JobSnapshot {
    const cancelled = workflow.termination === "cancelled";
    return {
      id: workflow.runId,
      kind: "workflow",
      label: workflow.summary,
      ownerSession: this.ownerSession,
      status: workflow.status === "running" ? "running" : cancelled ? "killed" : workflow.status,
      capabilities: { read: true, wait: true, send: false, cancel: workflow.status === "running" },
      cwd: this.cwd,
      startedAt: workflow.createdAt,
      updatedAt: workflow.updatedAt,
      ...(workflow.status !== "running" ? { finishedAt: workflow.updatedAt } : {}),
      metadata: {
        mode: workflow.plan.mode,
        totalTasks: workflow.plan.tasks.length,
        runningTasks: workflow.runningTaskIds.length,
        pendingTasks: workflow.pendingTaskIds.length,
      },
    };
  }

  private assertOwner(sessionId: string): void {
    if (sessionId !== this.ownerSession) throw new Error("Job owner session mismatch.");
  }
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

function childStatus(child: ChildObservation): JobStatus {
  if (child.handle.state === "starting" || child.handle.state === "running") return "running";
  if (child.handle.state === "closing") return "stopping";
  if (!child.result) return child.handle.state === "closed" ? "killed" : "running";
  if (child.result.status === "failed") return "failed";
  if (child.result.status === "interrupted" || child.result.status === "stopped") return "killed";
  return "completed";
}

function taskKind(type: DetachedProcessExecution["type"]): JobKind {
  return type === "shell" || type === "dream" ? type : "agent";
}

function taskStatus(status: DetachedProcessExecution["status"]): JobStatus {
  if (status === "completed" || status === "failed") return status;
  if (status === "stopped") return "killed";
  return "running";
}

function taskAcceptsInput(task: DetachedProcessExecution): boolean {
  return task.type === "agent" && task.status !== "stopped";
}

function formatWorkflowOutput(workflow: WorkflowRunSnapshot): string {
  return JSON.stringify({
    summary: workflow.summary,
    status: workflow.status,
    pendingTaskIds: workflow.pendingTaskIds,
    runningTaskIds: workflow.runningTaskIds,
    results: workflow.orderedResults,
  }, null, 2);
}

function workflowDetails(workflow: WorkflowRunSnapshot): Record<string, unknown> {
  const notification = createWorkflowNotification(createWorkflowResultFromSnapshot(workflow));
  return {
    status: workflow.status,
    termination: workflow.termination,
    plan: workflow.plan,
    pendingTaskIds: workflow.pendingTaskIds,
    blockedTaskIds: workflow.blockedTaskIds,
    blockedTasks: workflow.blockedTasks,
    runningTaskIds: workflow.runningTaskIds,
    runningTasks: workflow.runningTasks,
    results: workflow.results,
    budget: workflow.budget,
    needsReconciliation: notification.needsReconciliation,
    reconciliationIssues: notification.reconciliationIssues,
    reconciliationSummary: notification.reconciliationSummary,
    reconciliationPlan: notification.reconciliationPlan,
  };
}

function selectOutput(text: string, after: number | undefined, maxChars: number | undefined) {
  const cursor = text.length;
  const unread = after === undefined ? text : text.slice(Math.max(0, Math.floor(after)));
  return { ...limitOutput(unread, maxChars), cursor };
}

function limitOutput(text: string, maxChars = DEFAULT_OUTPUT_LIMIT) {
  const limit = maxChars === undefined || !Number.isFinite(maxChars)
    ? DEFAULT_OUTPUT_LIMIT
    : Math.max(1, Math.floor(maxChars));
  return text.length > limit
    ? { text: text.slice(-limit), truncated: true }
    : { text, truncated: false };
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, Math.max(1, ms));
    timer.unref?.();
    function done() {
      signal?.removeEventListener("abort", aborted);
      resolve();
    }
    function aborted() {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("Job wait aborted."));
    }
    signal?.addEventListener("abort", aborted, { once: true });
    if (signal?.aborted) aborted();
  });
}

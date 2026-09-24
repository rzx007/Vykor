import {
  cancelPersistentWorkflow,
  createWorkflowNotification,
  createWorkflowResultFromSnapshot,
  type WorkflowRunRepository,
  type WorkflowRunSnapshot,
} from "@vykor/coordinator";
import {
  filterJobSnapshots,
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
} from "@vykor/jobs";
import { DEFAULT_RETENTION_POLICY } from "@vykor/services";
import type { SessionRecord, SessionExecutionRecord } from "@vykor/protocol";
import type { TerminalSessionInfo } from "@vykor/terminal";

import type { DaemonTerminalService } from "../terminal/index.js";

export interface JobSessionQueries {
  getSession(sessionId: string): SessionRecord | undefined;
}

export interface JobTaskOperations {
  listSessionTasks(sessionId: string): SessionExecutionRecord[];
  getSessionTask(taskId: string): SessionExecutionRecord | undefined;
  updateSessionTask(taskId: string, input: {
    status: "stopped";
    output?: string;
    metadata?: Record<string, unknown>;
  }): SessionExecutionRecord;
  waitForSessionTaskChange?(taskId: string, after: number, options: {
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<SessionExecutionRecord | undefined>;
}

export interface JobSessionStore extends JobSessionQueries, JobTaskOperations {}

interface JobExecutionRuntime {
  readOutput(executionId: string): string;
  writeInput(executionId: string, data: string): Promise<void>;
  stopExecution(executionId: string): Promise<unknown>;
}

const DEFAULT_OUTPUT_LIMIT = 12_000;

type ResolvedJobSource =
  | { kind: "terminal"; value: TerminalSessionInfo }
  | { kind: "task"; value: SessionExecutionRecord }
  | {
      kind: "workflow";
      value: WorkflowRunSnapshot;
      cwd: string;
      repository: WorkflowRunRepository;
    };

interface AgentJobView {
  includesSnapshot(snapshot: JobSnapshot): boolean;
  includesSource(source: ResolvedJobSource): boolean;
}

const TERMINAL_AGENT_VIEW: AgentJobView = {
  includesSnapshot: (snapshot) => snapshot.kind === "terminal",
  includesSource: (source) => source.kind === "terminal",
};

export class DaemonJobService {
  constructor(
    private readonly store: JobSessionStore,
    private readonly terminals: DaemonTerminalService,
    private readonly getDetachedProcessSupervisor: (
      scope: { cwd: string; sessionId: string },
    ) => JobExecutionRuntime,
    private readonly getChildAgentExecutionRegistry: (
      scope: { cwd: string; sessionId: string },
    ) => JobExecutionRuntime,
    private readonly workflows: WorkflowRunRepository,
  ) {}

  createTerminalAgentHost(session: SessionRecord): AgentJobHost {
    return this.createScopedAgentHost(session, TERMINAL_AGENT_VIEW);
  }

  createDetachedProcessAgentHost(session: SessionRecord): AgentJobHost {
    return this.createScopedAgentHost(session, {
      includesSnapshot: (snapshot) => {
        const task = this.store.getSessionTask(snapshot.id);
        return task?.sessionId === snapshot.ownerSession &&
          isDetachedProcessAgentTask(task);
      },
      includesSource: (source) =>
        source.kind === "task" &&
        isDetachedProcessAgentTask(source.value),
    });
  }

  private createScopedAgentHost(
    session: SessionRecord,
    view: AgentJobView,
  ): AgentJobHost {
    return {
      list: async (input) => {
        const { limit, ...unlimitedInput } = this.owned(session, input);
        const snapshots = await this.list(unlimitedInput);
        return filterJobSnapshots(snapshots.filter(view.includesSnapshot), { limit });
      },
      read: async (input) => {
        const owned = this.owned(session, input);
        await this.assertVisible(owned.sessionId, owned.jobId, view);
        return await this.read(owned);
      },
      wait: async (input) => {
        const owned = this.owned(session, input);
        await this.assertVisible(owned.sessionId, owned.jobId, view);
        return await this.wait(owned);
      },
      send: async (input) => {
        const owned = this.owned(session, input);
        await this.assertVisible(owned.sessionId, owned.jobId, view);
        return await this.send(owned);
      },
      cancel: async (input) => {
        const owned = this.owned(session, input);
        await this.assertVisible(owned.sessionId, owned.jobId, view);
        return await this.cancel(owned);
      },
    };
  }

  private async assertVisible(
    sessionId: string,
    jobId: string,
    view: AgentJobView,
  ): Promise<void> {
    const source = await this.resolve(sessionId, jobId);
    if (!view.includesSource(source)) throw new Error(`Job not found: ${jobId}`);
  }

  async list(input: JobListRequest): Promise<JobSnapshot[]> {
    const session = this.requireSession(input.sessionId);
    const terminals = await this.terminals.list({ sessionId: session.id, source: "agent" });
    const tasks = this.store.listSessionTasks(session.id);
    const workflows = this.workflows
      .list()
      .filter((workflow) => workflow.ownerSession === session.id);
    const snapshots = [
      ...terminals.map(terminalSnapshot),
      ...tasks.map(taskSnapshot),
      ...workflows.map((workflow) => workflowSnapshot(workflow, session.cwd)),
    ];
    const visible = input.includeFinished === true
      ? snapshots
      : snapshots.filter((job) =>
          !isFinished(job.status) ||
          job.updatedAt < 1_000_000_000_000 ||
          job.updatedAt >= Date.now() - DEFAULT_RETENTION_POLICY.completedJobVisibleForMs,
        );
    return filterJobSnapshots(visible, input);
  }

  async read(input: JobReadRequest): Promise<JobReadResult> {
    const source = await this.resolve(input.sessionId, input.jobId);
    if (source.kind === "terminal") {
      const output = await this.terminals.readRequest({
        terminalId: source.value.id,
        after: input.after,
        maxChars: normalizeLimit(input.maxChars),
      });
      return {
        text: output.data,
        cursor: output.sequence,
        truncated: output.truncated,
        snapshot: terminalSnapshot(await this.terminals.get(source.value.id)),
      };
    }
    if (source.kind === "task") {
      const snapshot = taskSnapshot(source.value);
      const text = input.after !== undefined && input.after >= snapshot.updatedAt
        ? ""
        : this.readTaskOutput(source.value);
      const limited = limitOutput(text, input.maxChars);
      return { ...limited, cursor: snapshot.updatedAt, snapshot };
    }
    const snapshot = workflowSnapshot(source.value, source.cwd);
    const text = input.after !== undefined && input.after >= snapshot.updatedAt
      ? ""
      : formatWorkflowOutput(source.value);
    const limited = limitOutput(text, input.maxChars);
    return {
      ...limited,
      cursor: snapshot.updatedAt,
      snapshot,
      details: workflowDetails(source.value),
    };
  }

  async wait(input: JobWaitRequest): Promise<JobWaitResult> {
    if (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0) {
      throw new Error("Job wait timeoutMs must be a positive finite number.");
    }
    const source = await this.resolve(input.sessionId, input.jobId);
    if (source.kind === "terminal") {
      const waited = await this.terminals.wait({
        terminalId: source.value.id,
        timeoutMs: input.timeoutMs,
        after: input.after,
        maxChars: normalizeLimit(input.maxChars),
        signal: input.signal,
      });
      return {
        text: waited.data,
        cursor: waited.sequence,
        truncated: waited.truncated,
        snapshot: terminalSnapshot(waited.terminal),
        timedOut: waited.timedOut,
      };
    }
    const initial = await this.read(input);
    if (isFinished(initial.snapshot.status)) return { ...initial, timedOut: false };
    if (source.kind === "workflow" && source.repository.waitForChange) {
      await source.repository.waitForChange(source.value.runId, source.value.updatedAt, {
        timeoutMs: input.timeoutMs,
        signal: input.signal,
      });
      const current = await this.read(input);
      return { ...current, timedOut: !isFinished(current.snapshot.status) };
    }
    if (source.kind === "task" && this.store.waitForSessionTaskChange) {
      await this.store.waitForSessionTaskChange(source.value.id, source.value.updatedAt, {
        timeoutMs: input.timeoutMs,
        signal: input.signal,
      });
      const current = await this.read(input);
      return { ...current, timedOut: !isFinished(current.snapshot.status) };
    }
    return { ...initial, timedOut: true };
  }

  async send(input: { sessionId: string; jobId: string; data: string }): Promise<void> {
    const source = await this.resolve(input.sessionId, input.jobId);
    if (source.kind === "terminal") {
      await this.terminals.write({ terminalId: source.value.id, data: input.data });
      return;
    }
    if (source.kind === "task") {
      if (!taskAcceptsInput(source.value)) {
        throw new Error(`Job ${input.jobId} does not accept input.`);
      }
      const runtime = this.runtimeFor(source.value);
      await runtime.writeInput(runtimeExecutionId(source.value), input.data);
      return;
    }
    throw new Error(`Workflow ${input.jobId} does not accept input.`);
  }

  async cancel(input: JobCancelRequest): Promise<JobSnapshot> {
    const source = await this.resolve(input.sessionId, input.jobId);
    if (source.kind === "terminal") {
      await this.terminals.close(source.value.id);
      return terminalSnapshot(await this.terminals.get(source.value.id));
    }
    if (source.kind === "task") {
      if (source.value.status === "pending") {
        const stopped = this.store.updateSessionTask(source.value.id, {
          status: "stopped",
          metadata: { admissionPhase: "cancelled_before_start" },
        });
        return taskSnapshot(stopped);
      }
      const runtime = this.runtimeFor(source.value);
      await runtime.stopExecution(runtimeExecutionId(source.value));
      let output: string | undefined;
      try { output = runtime.readOutput(runtimeExecutionId(source.value)); } catch { /* durable output is optional */ }
      const stopped = this.store.updateSessionTask(source.value.id, {
        status: "stopped",
        ...(output !== undefined ? { output } : {}),
      });
      return taskSnapshot(stopped);
    }
    const session = this.requireSession(input.sessionId);
    await cancelPersistentWorkflow(source.value, {
      store: source.repository,
      reason: input.reason,
      stopTask: async (taskId) => await this.stopWorkflowWorker(session, taskId),
    });
    return workflowSnapshot(source.repository.load(source.value.runId)!, session.cwd);
  }

  /**
   * Workflow workers may be framework child Agents or detached processes.
   * Route stop through the same backend used for JobCancel on a plain task.
   */
  private async stopWorkflowWorker(session: SessionRecord, taskId: string): Promise<unknown> {
    const task = this.store.getSessionTask(taskId);
    if (task?.sessionId === session.id) {
      return this.runtimeFor(task).stopExecution(runtimeExecutionId(task));
    }
    const scope = { cwd: session.cwd, sessionId: session.id };
    try {
      return await this.getChildAgentExecutionRegistry(scope).stopExecution(taskId);
    } catch {
      return this.getDetachedProcessSupervisor(scope).stopExecution(taskId);
    }
  }

  private owned<T extends { sessionId: string }>(session: SessionRecord, input: T): T {
    if (!this.isSessionInTree(session.id, input.sessionId)) {
      throw new Error("Job owner session mismatch.");
    }
    return input;
  }

  private isSessionInTree(rootSessionId: string, candidateSessionId: string): boolean {
    let current = this.store.getSession(candidateSessionId);
    const visited = new Set<string>();
    while (current && !visited.has(current.id)) {
      if (current.id === rootSessionId) return true;
      visited.add(current.id);
      current = current.parentId ? this.store.getSession(current.parentId) : undefined;
    }
    return false;
  }

  private requireSession(sessionId: string): SessionRecord {
    const session = this.store.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    return session;
  }

  private runtimeFor(task: SessionExecutionRecord): JobExecutionRuntime {
    const session = this.requireSession(task.sessionId);
    const scope = { cwd: session.cwd, sessionId: task.sessionId };
    return executionBackend(task) === "child_agent"
      ? this.getChildAgentExecutionRegistry(scope)
      : this.getDetachedProcessSupervisor(scope);
  }

  private readTaskOutput(task: SessionExecutionRecord): string {
    try {
      return this.runtimeFor(task).readOutput(runtimeExecutionId(task));
    } catch {
      return task.output ?? "";
    }
  }

  private async resolve(
    sessionId: string,
    jobId: string,
  ): Promise<ResolvedJobSource> {
    this.requireSession(sessionId);
    const terminal = (await this.terminals.list({ sessionId, source: "agent" }))
      .find((candidate) => candidate.id === jobId);
    if (terminal) return { kind: "terminal", value: terminal };
    const task = this.store.getSessionTask(jobId);
    if (task?.sessionId === sessionId) return { kind: "task", value: task };
    const session = this.requireSession(sessionId);
    if (!jobId.startsWith("workflow:")) throw new Error(`Job not found: ${jobId}`);
    const repository = this.workflows;
    const workflow = repository.load(jobId.slice("workflow:".length));
    if (workflow?.ownerSession === sessionId) {
      return { kind: "workflow", value: workflow, cwd: session.cwd, repository };
    }
    throw new Error(`Job not found: ${jobId}`);
  }
}

function terminalSnapshot(terminal: TerminalSessionInfo): JobSnapshot {
  const updated = terminal.exitedAt ?? terminal.createdAt;
  return {
    id: terminal.id,
    kind: "terminal",
    label: terminal.name,
    ownerSession: terminal.sessionId!,
    status: terminal.status,
    capabilities: { read: true, wait: true, send: terminal.status === "running", cancel: terminal.status === "running" },
    cwd: terminal.cwd,
    startedAt: Date.parse(terminal.createdAt),
    updatedAt: Date.parse(updated),
    ...(terminal.exitedAt ? { finishedAt: Date.parse(terminal.exitedAt) } : {}),
    ...(terminal.exitCode !== undefined ? { detail: `exit code: ${terminal.exitCode ?? "signal"}` } : {}),
    ...(terminal.exitCode !== undefined ? { exitCode: terminal.exitCode } : {}),
    metadata: { runtime: terminal.runtime, shell: terminal.shell, source: terminal.source },
  };
}

function taskSnapshot(task: SessionExecutionRecord): JobSnapshot {
  return {
    id: task.id,
    kind: taskKind(task.type),
    label: task.description,
    ownerSession: task.sessionId,
    status: taskStatus(task.status),
    capabilities: {
      read: true,
      wait: true,
      send: taskAcceptsInput(task),
      cancel: task.status === "pending" || task.status === "running",
    },
    cwd: task.cwd,
    startedAt: task.startedAt ?? task.createdAt,
    updatedAt: task.updatedAt,
    ...(task.finishedAt ? { finishedAt: task.finishedAt } : {}),
    ...(task.error ? { detail: task.error } : {}),
    ...(task.status !== "pending" && task.status !== "running" &&
      task.metadata.executionBackend === "detached_process" &&
      (task.metadata.processExitCode === null ||
        (typeof task.metadata.processExitCode === "number" && Number.isInteger(task.metadata.processExitCode)))
      ? { exitCode: task.metadata.processExitCode as number | null } : {}),
    metadata: { ...task.metadata, ...(task.childSessionId ? { childSessionId: task.childSessionId } : {}) },
  };
}

function workflowSnapshot(workflow: WorkflowRunSnapshot, cwd: string): JobSnapshot {
  const cancelled = workflow.termination === "cancelled";
  return {
    id: qualifiedWorkflowId(workflow.runId),
    kind: "workflow",
    label: workflow.summary,
    ownerSession: workflow.ownerSession!,
    status: workflow.status === "running" ? "running" : cancelled ? "killed" : workflow.status,
    capabilities: { read: true, wait: true, send: false, cancel: workflow.status === "running" },
    cwd,
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

function taskKind(type: string): JobKind {
  return type === "shell" || type === "dream" ? type : "agent";
}

function taskStatus(status: SessionExecutionRecord["status"]): JobStatus {
  if (status === "completed" || status === "failed") return status;
  if (status === "stopped" || status === "interrupted") return "killed";
  return "running";
}

function taskAcceptsInput(task: SessionExecutionRecord): boolean {
  return task.type === "agent" && task.status !== "stopped" && task.status !== "interrupted";
}

function runtimeExecutionId(task: SessionExecutionRecord): string {
  if (typeof task.metadata.runtimeExecutionId === "string") return task.metadata.runtimeExecutionId;
  if (typeof task.metadata.taskManagerId === "string") return task.metadata.taskManagerId;
  return task.id;
}

function executionBackend(task: SessionExecutionRecord): "detached_process" | "child_agent" {
  if (task.metadata.executionBackend === "child_agent") return "child_agent";
  if (task.metadata.executionBackend === "detached_process") return "detached_process";
  return task.metadata.origin === "child_session" ? "child_agent" : "detached_process";
}

function isDetachedProcessAgentTask(task: SessionExecutionRecord): boolean {
  if (
    task.childSessionId ||
    task.metadata.executionBackend === "child_agent" ||
    task.metadata.origin === "child_session"
  ) {
    return false;
  }
  return task.type === "shell" ||
    task.metadata.executionBackend === "detached_process";
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

function normalizeLimit(value: number | undefined): number {
  return value === undefined || !Number.isFinite(value)
    ? DEFAULT_OUTPUT_LIMIT
    : Math.max(1, Math.floor(value));
}

function limitOutput(text: string, maxChars = DEFAULT_OUTPUT_LIMIT): Pick<JobReadResult, "text" | "truncated"> {
  const limit = normalizeLimit(maxChars);
  return text.length > limit ? { text: text.slice(-limit), truncated: true } : { text, truncated: false };
}

function isFinished(status: JobStatus): boolean {
  return status === "completed" || status === "failed" || status === "killed";
}

function qualifiedWorkflowId(runId: string): string {
  return `workflow:${runId}`;
}

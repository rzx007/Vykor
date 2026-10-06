import {
  cancelPersistentWorkflow,
  type WorkflowRunRepository,
  type WorkflowRunSnapshot,
} from "@vykor/coordinator";
import {
  filterJobSnapshots,
  type AgentJobHost,
  type JobCancelRequest,
  type JobListRequest,
  type JobReadRequest,
  type JobReadResult,
  type JobSnapshot,
  type JobWaitRequest,
  type JobWaitResult,
} from "@vykor/jobs";
import { DEFAULT_RETENTION_POLICY } from "@vykor/services";
import type { SessionExecutionRecord, SessionRecord, SessionTaskStatus } from "@vykor/protocol";
import type { SessionExecutionProjector, DetachedProcessRuntime } from "../application/session/session-execution-projector.js";
import type { DaemonOperationGate } from "../application/control/daemon-operation-gate.js";
import type { ChildActivitySnapshot } from "@vykor/core";
import type { TerminalSessionInfo } from "@vykor/terminal";

import type { DaemonTerminalService } from "../terminal/index.js";
import {
  executionBackend,
  formatWorkflowOutput,
  isDetachedProcessAgentTask,
  isFinished,
  limitOutput,
  normalizeLimit,
  readChildFailure,
  runtimeExecutionId,
  taskAcceptsInput,
  taskSnapshot,
  terminalSnapshot,
  workflowDetails,
  workflowSnapshot,
} from "./job-snapshots.js";

export { readPersistedChildActivity, type ChildActivityReader } from "./child-activity.js";

export interface JobSessionQueries {
  getSession(sessionId: string): SessionRecord | undefined;
  /** Read-only bounded activity of a verified child Run; omit when the identity cannot be verified. */
  readChildActivity?(input: {
    parentSessionId: string;
    childSessionId: string;
    runId?: string;
  }): ChildActivitySnapshot | undefined;
}

export interface JobTaskOperations {
  listSessionTasks(sessionId: string): SessionExecutionRecord[];
  getSessionTask(taskId: string): SessionExecutionRecord | undefined;
  updateSessionTask(taskId: string, input: {
    status: SessionTaskStatus;
    output?: string;
    error?: string;
    metadata?: Record<string, unknown>;
  }): SessionExecutionRecord;
  transitionPendingSessionTask(taskId: string, input: {
    status: SessionTaskStatus;
    metadata?: Record<string, unknown>;
  }): { task: SessionExecutionRecord; transitioned: boolean };
  waitForSessionTaskChange?(taskId: string, after: number, options: {
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<SessionExecutionRecord | undefined>;
}

export interface JobSessionStore extends JobSessionQueries, JobTaskOperations {}

interface JobExecutionRuntime {
  readOutput(executionId: string, maxBytes?: number): string;
  writeInput(executionId: string, data: string): Promise<void>;
  stopExecution(executionId: string): Promise<unknown>;
  registerExecutionListener?: DetachedProcessRuntime["registerExecutionListener"];
}

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
    private readonly executionProjector?: Pick<SessionExecutionProjector, "trackProcessExecution">,
    private readonly operationGate?: Pick<DaemonOperationGate, "enter">,
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
      const activity = this.readTaskActivity(source.value);
      const childFailure = readChildFailure(source.value);
      return {
        ...limited,
        cursor: snapshot.updatedAt,
        snapshot,
        ...(activity || childFailure
          ? {
              details: {
                ...(activity ? { activity } : {}),
                ...(childFailure ? { childFailure } : {}),
              },
            }
          : {}),
      };
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
      const previous = source.value.updatedAt;
      const changed = await this.store.waitForSessionTaskChange(source.value.id, previous, {
        timeoutMs: input.timeoutMs,
        signal: input.signal,
      });
      const current = await this.read(input);
      const finished = isFinished(current.snapshot.status);
      return {
        ...current,
        timedOut: !finished && !(changed !== undefined && changed.updatedAt > previous),
      };
    }
    return { ...initial, timedOut: true };
  }

  async send(input: { sessionId: string; jobId: string; data: string }): Promise<void> {
    const session = this.requireSession(input.sessionId);
    const lease = this.operationGate?.enter({ sessionId: session.id, cwd: session.cwd });
    try { await this.sendAdmitted(input); }
    finally { lease?.release(); }
  }

  private async sendAdmitted(input: { sessionId: string; jobId: string; data: string }): Promise<void> {
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
      const reopen = source.value.type === "agent" && (source.value.status === "completed" || source.value.status === "failed");
      if (reopen) {
        this.store.updateSessionTask(source.value.id, { status: "running", error: "" });
        if (executionBackend(source.value) === "detached_process" && runtime.registerExecutionListener) {
          this.executionProjector?.trackProcessExecution(runtime as DetachedProcessRuntime, runtimeExecutionId(source.value), source.value.id);
        }
      }
      try { await runtime.writeInput(runtimeExecutionId(source.value), input.data); }
      catch (error) {
        if (reopen) this.store.updateSessionTask(source.value.id, { status: source.value.status, ...(source.value.output !== undefined ? { output: source.value.output } : {}), error: source.value.error ?? "" });
        throw error;
      }
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
        const stopped = this.store.transitionPendingSessionTask(source.value.id, {
          status: "stopped",
          metadata: { admissionPhase: "cancelled_before_start" },
        });
        if (stopped.transitioned || stopped.task.status !== "running") return taskSnapshot(stopped.task);
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
      return this.runtimeFor(task).readOutput(runtimeExecutionId(task), Number.MAX_SAFE_INTEGER);
    } catch {
      return task.output ?? "";
    }
  }

  private readTaskActivity(task: SessionExecutionRecord): ChildActivitySnapshot | undefined {
    if (!task.childSessionId || executionBackend(task) !== "child_agent") return undefined;
    const query = this.store.readChildActivity;
    if (!query) return undefined;
    return query({
      parentSessionId: task.sessionId,
      childSessionId: task.childSessionId,
      ...(task.runId ? { runId: task.runId } : {}),
    });
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

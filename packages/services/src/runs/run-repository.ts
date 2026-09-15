import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import type {
  AppendEventInput,
  CreateRunAttemptInput,
  CreateRunInput,
  CreateSessionTaskInput,
  SessionEventRecord,
  SessionExecutionRecord,
  SessionRecord,
  SessionRunAttemptRecord,
  SessionRunRecord,
  UpdateRunAttemptInput,
  UpdateRunInput,
  UpdateSessionTaskInput,
} from "@openharness/protocol";

import type { StorageContext } from "../database/storage-context.js";
import {
  assertMutableSession,
  assertSession,
  clone,
  isTerminalAttemptStatus,
  isTerminalRunStatus,
  now,
} from "../session-runtime/store-state.js";

export interface RunRepositoryOptions {
  storage: StorageContext;
  appendEvent?: (input: AppendEventInput) => SessionEventRecord;
  save?: () => void;
}

export class RunRepository {
  private readonly storage: StorageContext;
  private readonly appendEvent?: (input: AppendEventInput) => SessionEventRecord;
  private readonly saveChanges?: () => void;

  constructor(options: StorageContext | RunRepositoryOptions) {
    if ("state" in options) {
      this.storage = options;
    } else {
      this.storage = options.storage;
      this.appendEvent = options.appendEvent;
      this.saveChanges = options.save;
    }
  }

  private refreshSessionStatus(session: SessionRecord): void {
    if (session.status === "archived" || session.status === "closing") return;
    const hasActiveRun = Object.values(this.storage.state.runs).some(
      (run) =>
        run.sessionId === session.id &&
        (run.status === "pending" || run.status === "running"),
    );
    session.status = hasActiveRun ? "running" : "idle";
  }

  createRun(input: CreateRunInput): SessionRunRecord {
    const session = assertSession(this.storage.state, input.sessionId);
    assertMutableSession(session);
    if (input.inputId && !this.storage.state.inputs[input.inputId]) {
      throw new Error(`Session input not found: ${input.inputId}`);
    }
    if (
      input.inputId &&
      this.storage.state.inputs[input.inputId]!.sessionId !== input.sessionId
    ) {
      throw new Error(
        `Session input does not belong to session: ${input.inputId}`,
      );
    }
    const id = input.id ?? randomUUID();
    if (this.storage.state.runs[id])
      throw new Error(`Session run already exists: ${id}`);
    const timestamp = now();
    const run: SessionRunRecord = {
      id,
      sessionId: input.sessionId,
      ...(input.inputId ? { inputId: input.inputId } : {}),
      status: "pending",
      metadata: input.metadata ?? {},
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.storage.state.runs[id] = run;
    this.refreshSessionStatus(session);
    session.updatedAt = timestamp;
    this.storage.mutations.runs.add(id);
    this.storage.mutations.sessions.add(session.id);
    this.appendEvent?.({
      type: "session.run.created",
      sessionId: input.sessionId,
      payload: { run },
    });
    this.saveChanges?.();
    return clone(run);
  }

  updateRun(runId: string, input: UpdateRunInput): SessionRunRecord {
    const run = this.storage.state.runs[runId];
    if (!run) throw new Error(`Session run not found: ${runId}`);
    const session = assertSession(this.storage.state, run.sessionId);
    const timestamp = now();
    const previous = run.status;
    if (input.status) {
      if (isTerminalRunStatus(previous) && input.status !== previous) {
        throw new Error(`Session run is already terminal: ${runId}`);
      }
      run.status = input.status;
      if (input.status === "running" && previous !== "running") {
        run.startedAt = timestamp;
        delete run.finishedAt;
        delete run.error;
      }
      if (["completed", "failed", "interrupted"].includes(input.status))
        run.finishedAt = timestamp;
    }
    if (input.error !== undefined) run.error = input.error;
    if (input.metadata) run.metadata = { ...run.metadata, ...input.metadata };
    run.updatedAt = timestamp;
    this.refreshSessionStatus(session);
    session.updatedAt = timestamp;
    this.storage.mutations.runs.add(runId);
    this.storage.mutations.sessions.add(session.id);
    this.appendEvent?.({
      type: "session.run.updated",
      sessionId: run.sessionId,
      payload: { run, previousStatus: previous },
    });
    this.saveChanges?.();
    return clone(run);
  }

  createRunAttempt(input: CreateRunAttemptInput): SessionRunAttemptRecord {
    const run = this.storage.state.runs[input.runId];
    if (!run) throw new Error(`Session run not found: ${input.runId}`);
    if (isTerminalRunStatus(run.status))
      throw new Error(`Session run is already terminal: ${input.runId}`);
    const attempts = Object.values(this.storage.state.attempts).filter(
      (attempt) => attempt.runId === input.runId,
    );
    const sequence =
      input.sequence ??
      attempts.reduce((max, attempt) => Math.max(max, attempt.sequence), 0) + 1;
    if (attempts.some((attempt) => attempt.sequence === sequence)) {
      throw new Error(
        `Session run attempt sequence already exists: ${input.runId}/${sequence}`,
      );
    }
    const id = input.id ?? `attempt_${randomUUID()}`;
    if (this.storage.state.attempts[id])
      throw new Error(`Session run attempt already exists: ${id}`);
    const timestamp = now();
    const attempt: SessionRunAttemptRecord = {
      id,
      runId: input.runId,
      sequence,
      status: "pending",
      ...(input.provider ? { provider: input.provider } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.retryReason ? { retryReason: input.retryReason } : {}),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.storage.state.attempts[id] = attempt;
    this.storage.mutations.attempts.add(id);
    this.appendEvent?.({
      type: "session.run_attempt.created",
      sessionId: run.sessionId,
      payload: { attempt },
    });
    this.saveChanges?.();
    return clone(attempt);
  }

  updateRunAttempt(
    attemptId: string,
    input: UpdateRunAttemptInput,
  ): SessionRunAttemptRecord {
    const attempt = this.storage.state.attempts[attemptId];
    if (!attempt)
      throw new Error(`Session run attempt not found: ${attemptId}`);
    const run = this.storage.state.runs[attempt.runId];
    if (!run) throw new Error(`Session run not found: ${attempt.runId}`);
    const previous = attempt.status;
    const timestamp = now();
    if (input.status) {
      if (isTerminalAttemptStatus(previous) && input.status !== previous) {
        throw new Error(
          `Session run attempt is already terminal: ${attemptId}`,
        );
      }
      attempt.status = input.status;
      if (input.status === "running" && previous !== "running") {
        attempt.startedAt = timestamp;
        delete attempt.finishedAt;
        delete attempt.error;
        delete attempt.errorKind;
      }
      if (isTerminalAttemptStatus(input.status)) attempt.finishedAt = timestamp;
    }
    if (input.errorKind !== undefined) attempt.errorKind = input.errorKind;
    if (input.error !== undefined) attempt.error = input.error;
    if (input.inputTokens !== undefined)
      attempt.inputTokens = input.inputTokens;
    if (input.outputTokens !== undefined)
      attempt.outputTokens = input.outputTokens;
    attempt.updatedAt = timestamp;
    this.storage.mutations.attempts.add(attemptId);
    this.appendEvent?.({
      type: "session.run_attempt.updated",
      sessionId: run.sessionId,
      payload: { attempt, previousStatus: previous },
    });
    this.saveChanges?.();
    return clone(attempt);
  }

  getRun(runId: string): SessionRunRecord | undefined {
    const run = this.storage.state.runs[runId];
    return run ? clone(run) : undefined;
  }

  findRunByInput(inputId: string): SessionRunRecord | undefined {
    const direct = this.findOwningRunByInput(inputId);
    if (direct) return clone(direct);
    const promoted = Object.values(this.storage.state.messages).find(
      (message) => message.inputId === inputId && message.runId,
    );
    const run = promoted?.runId ? this.storage.state.runs[promoted.runId] : undefined;
    return run ? clone(run) : undefined;
  }

  listRunsByInput(inputId: string): SessionRunRecord[] {
    return clone(
      Object.values(this.storage.state.runs)
        .filter((candidate) => candidate.inputId === inputId)
        .sort(
          (left, right) =>
            left.createdAt - right.createdAt || left.id.localeCompare(right.id),
        ),
    );
  }

  findOwningRunByInput(inputId: string): SessionRunRecord | undefined {
    return this.listRunsByInput(inputId)[0];
  }

  listRuns(sessionId: string): SessionRunRecord[] {
    assertSession(this.storage.state, sessionId);
    return clone(
      Object.values(this.storage.state.runs)
        .filter((run) => run.sessionId === sessionId)
        .sort((a, b) => a.createdAt - b.createdAt),
    );
  }

  getRunAttempt(attemptId: string): SessionRunAttemptRecord | undefined {
    const attempt = this.storage.state.attempts[attemptId];
    return attempt ? clone(attempt) : undefined;
  }

  listRunAttempts(runId: string): SessionRunAttemptRecord[] {
    if (!this.storage.state.runs[runId])
      throw new Error(`Session run not found: ${runId}`);
    return clone(
      Object.values(this.storage.state.attempts)
        .filter((attempt) => attempt.runId === runId)
        .sort((left, right) => left.sequence - right.sequence),
    );
  }

  getSessionTask(taskId: string): SessionExecutionRecord | undefined {
    const task = this.storage.state.tasks[taskId];
    return task ? clone(task) : undefined;
  }

  listSessionTasks(sessionId: string): SessionExecutionRecord[] {
    assertSession(this.storage.state, sessionId);
    return clone(
      Object.values(this.storage.state.tasks)
        .filter((task) => task.sessionId === sessionId)
        .sort((a, b) => a.createdAt - b.createdAt),
    );
  }

  findSessionExecutionByRuntimeId(
    sessionId: string,
    runtimeExecutionId: string,
  ): SessionExecutionRecord | undefined {
    assertSession(this.storage.state, sessionId);
    const task = Object.values(this.storage.state.tasks).find(
      (candidate) =>
        candidate.sessionId === sessionId &&
        (candidate.metadata.runtimeExecutionId === runtimeExecutionId ||
          candidate.metadata.taskManagerId === runtimeExecutionId),
    );
    return task ? clone(task) : undefined;
  }

  createSessionTask(input: CreateSessionTaskInput): SessionExecutionRecord {
    const session = assertSession(this.storage.state, input.sessionId);
    if (
      (input.requestNamespace === undefined) !==
      (input.requestId === undefined)
    ) {
      throw new Error(
        "Session task requestNamespace and requestId must be provided together",
      );
    }
    if (input.requestNamespace && input.requestId) {
      const existing = Object.values(this.storage.state.tasks).find(
        (task) =>
          task.sessionId === input.sessionId &&
          task.requestNamespace === input.requestNamespace &&
          task.requestId === input.requestId,
      );
      if (existing)
        throw new Error(`Session task request already exists: ${existing.id}`);
    }
    const id = input.id ?? randomUUID();
    if (this.storage.state.tasks[id])
      throw new Error(`Session task already exists: ${id}`);
    if (input.childSessionId) {
      const child = assertSession(this.storage.state, input.childSessionId);
      if (child.parentId !== input.sessionId) {
        throw new Error(
          `Child session does not belong to task session: ${input.childSessionId}`,
        );
      }
    }
    if (input.runId) {
      const run = this.storage.state.runs[input.runId];
      if (
        !run ||
        (run.sessionId !== input.childSessionId &&
          run.sessionId !== input.sessionId)
      ) {
        throw new Error(
          `Task run does not belong to task session: ${input.runId}`,
        );
      }
    }
    const timestamp = now();
    const task: SessionExecutionRecord = {
      id,
      sessionId: input.sessionId,
      ...(input.requestNamespace
        ? { requestNamespace: input.requestNamespace }
        : {}),
      ...(input.requestId ? { requestId: input.requestId } : {}),
      ...(input.childSessionId ? { childSessionId: input.childSessionId } : {}),
      ...(input.runId ? { runId: input.runId } : {}),
      type: input.type,
      status: input.status ?? "running",
      description: input.description,
      cwd: resolve(input.cwd),
      metadata: input.metadata ?? {},
      createdAt: timestamp,
      ...((input.status ?? "running") === "running"
        ? { startedAt: timestamp }
        : {}),
      updatedAt: timestamp,
    };
    this.storage.state.tasks[id] = task;
    session.updatedAt = timestamp;
    this.storage.mutations.tasks.add(id);
    this.storage.mutations.sessions.add(session.id);
    this.appendEvent?.({
      type: "session.task.created",
      sessionId: task.sessionId,
      payload: { task },
    });
    this.saveChanges?.();
    return clone(task);
  }

  /** Atomically reserves one durable task for a producer request. */
  reserveSessionTask(
    input: CreateSessionTaskInput & {
      requestNamespace: string;
      requestId: string;
    },
  ): { task: SessionExecutionRecord; created: boolean } {
    const existing = Object.values(this.storage.state.tasks).find(
      (task) =>
        task.sessionId === input.sessionId &&
        task.requestNamespace === input.requestNamespace &&
        task.requestId === input.requestId,
    );
    if (existing) return { task: clone(existing), created: false };
    return {
      task: this.createSessionTask({ ...input, status: "pending" }),
      created: true,
    };
  }

  /**
   * Confirms or fails an admitted task only while it is still pending.
   * The check and update are synchronous so a concurrent stop cannot be
   * overwritten by a stale process-start result.
   */
  transitionPendingSessionTask(
    taskId: string,
    input: UpdateSessionTaskInput,
  ): { task: SessionExecutionRecord; transitioned: boolean } {
    const current = this.storage.state.tasks[taskId];
    if (!current) throw new Error(`Session task not found: ${taskId}`);
    if (current.status !== "pending") {
      return { task: clone(current), transitioned: false };
    }
    return { task: this.updateSessionTask(taskId, input), transitioned: true };
  }

  updateSessionTask(
    taskId: string,
    input: UpdateSessionTaskInput,
  ): SessionExecutionRecord {
    const task = this.storage.state.tasks[taskId];
    if (!task) throw new Error(`Session task not found: ${taskId}`);
    const session = assertSession(this.storage.state, task.sessionId);
    if (input.runId !== undefined) {
      const run = this.storage.state.runs[input.runId];
      if (
        !run ||
        (run.sessionId !== task.sessionId &&
          run.sessionId !== task.childSessionId)
      ) {
        throw new Error(`Task run does not belong to task: ${input.runId}`);
      }
      task.runId = input.runId;
    }
    const timestamp = now();
    const previousStatus = task.status;
    if (input.status) {
      task.status = input.status;
      if (input.status === "running" && previousStatus !== "running") {
        task.startedAt = timestamp;
        delete task.finishedAt;
        delete task.output;
        delete task.error;
      }
      if (
        ["completed", "failed", "stopped", "interrupted"].includes(input.status)
      )
        task.finishedAt = timestamp;
    }
    if (input.output !== undefined) task.output = input.output;
    if (input.error !== undefined) task.error = input.error;
    if (input.metadata) task.metadata = { ...task.metadata, ...input.metadata };
    task.updatedAt = timestamp;
    session.updatedAt = timestamp;
    this.storage.mutations.tasks.add(taskId);
    this.storage.mutations.sessions.add(session.id);
    this.appendEvent?.({
      type: "session.task.updated",
      sessionId: task.sessionId,
      payload: { task, previousStatus },
    });
    this.saveChanges?.();
    return clone(task);
  }
}

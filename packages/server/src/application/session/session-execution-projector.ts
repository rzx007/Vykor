import type { ChildFailureKind, ChildPartialResult } from "@vykor/core";
import type { ObservabilityEvent } from "../../shared/observability.js";
import type { SessionEventPublisher } from "./session-event-publisher.js";

export interface SessionChildExecutionBridge {
  registerChildExecution(input: {
    id: string;
    description: string;
    cwd: string;
    sessionId: string;
    childSessionId: string;
    prompt: string;
    onInput(data: string): Promise<void>;
    onStop(): Promise<void>;
  }): { id: string };
  bindChildExecutionRun(taskId: string, runId: string): Promise<void>;
  releaseChildExecution(taskId: string): void;
  completeChildExecution(
    taskId: string,
    input: {
      status: "completed" | "failed" | "stopped" | "interrupted";
      output: string;
      failureKind?: ChildFailureKind;
      partialResult?: ChildPartialResult;
    },
  ): Promise<unknown>;
}

export interface ExecutionInfo {
  id: string;
  type: string;
  status: string;
  description: string;
  cwd: string;
  metadata: Record<string, unknown>;
  processExitCode?: number | null;
}

type DurableTaskStatus = "pending" | "running" | "completed" | "failed" | "stopped" | "interrupted";

export interface ChildAgentRegistry {
  releaseChildExecution(taskId: string): void;
  beginExecution(taskId: string): ExecutionInfo;
  completeExecution(
    taskId: string,
    input: { status: "completed" | "failed" | "stopped"; output: string },
  ): Promise<unknown>;
  registerChildExecution(input: Parameters<SessionChildExecutionBridge["registerChildExecution"]>[0]): ExecutionInfo;
}

export interface DetachedProcessRuntime {
  readOutput(executionId: string): string;
  registerExecutionListener(listener: (execution: ExecutionInfo) => void): () => void;
}

export type ChildAgentRegistryFactory = (scope: { cwd: string; sessionId: string }) => ChildAgentRegistry;

interface SessionTaskStore {
  createSessionTask(input: {
    id: string;
    sessionId: string;
    childSessionId?: string;
    type: string;
    description: string;
    cwd: string;
    metadata: Record<string, unknown>;
  }): unknown;
  getSessionTask(taskId: string): {
    id: string;
    sessionId: string;
    status: DurableTaskStatus;
    runId?: string;
  } | undefined;
  updateSessionTask(taskId: string, input: {
    status: DurableTaskStatus;
    runId?: string;
    output?: string;
    error?: string;
    metadata?: Record<string, unknown>;
  }): { sessionId: string };
}

export interface SessionExecutionProjectorContext {
  store: SessionTaskStore;
  getChildAgentExecutionRegistry: ChildAgentRegistryFactory;
  events: Pick<SessionEventPublisher, "checkpoint" | "publishSince">;
  traceIdForRun(runId: string): string;
  log(event: ObservabilityEvent): void;
}

/**
 * 为每个 session 生成 bridge：把 framework child Agent registry 与 store 的
 * SessionTask 持久化投影对齐。后台进程在持久化预留成功后显式接入监听。
 */
export class SessionExecutionProjector {
  private readonly trackedTasks = new WeakMap<object, Set<string>>();
  private readonly taskUnsubscribers = new WeakMap<object, Map<string, () => void>>();

  constructor(private readonly context: SessionExecutionProjectorContext) {}

  createBridge(session: { id: string; cwd: string }): SessionChildExecutionBridge {
    const registry = this.context.getChildAgentExecutionRegistry({ cwd: session.cwd, sessionId: session.id });
    return {
      releaseChildExecution: (taskId) => registry.releaseChildExecution(taskId),
      registerChildExecution: (input) => {
        const before = this.context.events.checkpoint();
        this.context.store.createSessionTask({
          id: input.id,
          sessionId: input.sessionId,
          childSessionId: input.childSessionId,
          type: "agent",
          description: input.description,
          cwd: input.cwd,
          metadata: {
            origin: "child_session",
            agent: input.description,
            executionBackend: "child_agent",
            runtimeExecutionId: input.id,
          },
        });
        let task: ExecutionInfo;
        try {
          task = registry.registerChildExecution(input);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.context.store.updateSessionTask(input.id, {
            status: "failed",
            output: message,
            error: message,
          });
          this.context.events.publishSince(before);
          throw error;
        }
        this.context.log({
          level: "info",
          event: "session.task.created",
          sessionId: input.sessionId,
          taskId: task.id,
        });
        this.context.events.publishSince(before);
        return { id: task.id };
      },
      bindChildExecutionRun: async (taskId, runId) => {
        const before = this.context.events.checkpoint();
        registry.beginExecution(taskId);
        const task = this.context.store.updateSessionTask(taskId, { status: "running", runId });
        this.context.log({
          level: "info",
          event: "session.task.bound",
          traceId: this.context.traceIdForRun(runId),
          sessionId: task.sessionId,
          runId,
          taskId,
        });
        this.context.events.publishSince(before);
      },
      completeChildExecution: async (taskId, input) => {
        const registryStatus = input.status === "interrupted" ? "stopped" : input.status;
        let task: unknown;
        let registryError: unknown;
        try {
          task = await registry.completeExecution(taskId, { ...input, status: registryStatus });
        } catch (error) {
          registryError = error;
        }
        const before = this.context.events.checkpoint();
        const failureMetadata = childFailureMetadata(input);
        this.context.store.updateSessionTask(taskId, {
          status: input.status,
          output: input.output,
          ...(input.status === "failed" ? { error: input.output } : {}),
          ...(failureMetadata ? { metadata: { childFailure: failureMetadata } } : {}),
        });
        const persisted = this.context.store.getSessionTask(taskId);
        this.context.log({
          level: input.status === "failed" ? "error" : "info",
          event: "session.task.completed",
          ...(persisted?.runId ? {
            traceId: this.context.traceIdForRun(persisted.runId),
            runId: persisted.runId,
          } : {}),
          sessionId: persisted?.sessionId ?? session.id,
          taskId,
          ...(input.status === "failed" ? { error: "task failed" } : {}),
        });
        this.context.events.publishSince(before);
        if (registryError) {
          this.context.log({
            level: "warn",
            event: "session.execution.registry_completion_failed",
            sessionId: persisted?.sessionId ?? session.id,
            taskId,
            error: registryError instanceof Error ? registryError.message : String(registryError),
          });
        }
        return task;
      },
    };
  }

  trackProcessExecution(runtime: DetachedProcessRuntime, taskId: string, durableTaskId = taskId): void {
    const tracked = this.trackedTasks.get(runtime as object) ?? new Set<string>();
    if (tracked.has(taskId)) return;
    tracked.add(taskId);
    this.trackedTasks.set(runtime as object, tracked);
    const unregister = runtime.registerExecutionListener((task) => {
      if (task.id !== taskId) return;
      const persisted = this.context.store.getSessionTask(durableTaskId);
      if (!persisted) {
        if (isTerminalRuntimeStatus(task.status)) this.untrackProcessExecution(runtime, taskId);
        return;
      }
      this.syncPersistentExecution(task, runtime, durableTaskId);
    });
    if (typeof unregister === "function") {
      const unsubscribers = this.taskUnsubscribers.get(runtime as object) ?? new Map<string, () => void>();
      unsubscribers.set(taskId, unregister);
      this.taskUnsubscribers.set(runtime as object, unsubscribers);
    }
  }

  syncPersistentExecution(task: ExecutionInfo, runtime: DetachedProcessRuntime, durableTaskId = task.id): void {
    const status: DurableTaskStatus = task.status === "pending" || task.status === "running" ||
      task.status === "completed" || task.status === "failed" || task.status === "stopped" ? task.status : "failed";
    const persisted = this.context.store.getSessionTask(durableTaskId);
    if (
      persisted &&
      isTerminalTaskStatus(persisted.status) &&
      (status === "pending" || status === "running")
    ) return;
    let output: string | undefined;
    try { output = runtime.readOutput(task.id); } catch { /* output is optional */ }
    const metadata: Record<string, unknown> = {};
    if (task.processExitCode === null ||
      (typeof task.processExitCode === "number" && Number.isInteger(task.processExitCode))) {
      metadata.processExitCode = task.processExitCode;
    }
    if (typeof task.metadata.outputDiscardedBytes === "string" && /^[1-9]\d*$/.test(task.metadata.outputDiscardedBytes)) {
      metadata.outputDiscardedBytes = task.metadata.outputDiscardedBytes;
    }
    if (task.metadata.outputWriteFailed === "1") metadata.outputWriteFailed = "1";
    const before = this.context.events.checkpoint();
    this.context.store.updateSessionTask(durableTaskId, {
      status,
      ...(output !== undefined ? { output } : {}),
      ...(status === "failed" ? { error: output ?? "Task failed" } : {}),
      ...(Object.keys(metadata).length ? { metadata } : {}),
    });
    this.context.events.publishSince(before);
    if (isTerminalTaskStatus(status)) this.untrackProcessExecution(runtime, task.id);
  }

  private untrackProcessExecution(runtime: DetachedProcessRuntime, taskId: string): void {
    const runtimeKey = runtime as object;
    this.taskUnsubscribers.get(runtimeKey)?.get(taskId)?.();
    this.taskUnsubscribers.get(runtimeKey)?.delete(taskId);
    this.trackedTasks.get(runtimeKey)?.delete(taskId);
  }
}

function isTerminalTaskStatus(status: DurableTaskStatus): boolean {
  return status === "completed" || status === "failed" || status === "stopped" || status === "interrupted";
}

/** Persist only the trusted terminal detail; absent fields are never fabricated. */
export function childFailureMetadata(input: {
  failureKind?: ChildFailureKind;
  partialResult?: ChildPartialResult;
}): { failureKind?: ChildFailureKind; partialResult?: ChildPartialResult } | undefined {
  const metadata: { failureKind?: ChildFailureKind; partialResult?: ChildPartialResult } = {};
  if (input.failureKind !== undefined) metadata.failureKind = input.failureKind;
  if (input.partialResult !== undefined) metadata.partialResult = input.partialResult;
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function isTerminalRuntimeStatus(status: string): boolean {
  return status === "completed" || status === "failed" || status === "stopped" || status === "interrupted";
}

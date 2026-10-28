import type { ObservabilityEvent } from "../../../shared/observability.js";
import type { SessionEventPublisher } from "./session-event-publisher.js";
import { recoverProjectionSettlements, type ProcessSettlementStore } from "../../agent/projection-settlement-recovery.js";

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

export interface DetachedProcessRuntime {
  readOutput(executionId: string): string;
  registerExecutionListener(listener: (execution: ExecutionInfo) => void): () => void;
}


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
  store: SessionTaskStore & Partial<ProcessSettlementStore>;
  events: Pick<SessionEventPublisher, "checkpoint" | "publishSince">;
  traceIdForRun(runId: string): string;
  log(event: ObservabilityEvent): void;
}

/**
 * 订阅已有 supervisor 的进程事件并更新持久任务。child 由 Agent 事件投影器保存。
 */
export class SessionExecutionProjector {
  private readonly trackedTasks = new WeakMap<object, Set<string>>();
  private readonly taskUnsubscribers = new WeakMap<object, Map<string, () => void>>();

  constructor(private readonly context: SessionExecutionProjectorContext) {}

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
    const projector = `process-terminal:${task.id}`;
    const repair = this.processSettlementStore();
    if (repair) recoverProjectionSettlements(repair, { projector });
    const status: DurableTaskStatus = task.status === "stopping" ? "running" : task.status === "pending" || task.status === "running" ||
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
    const update = {
      status,
      ...(output !== undefined ? { output } : {}),
      ...(status === "failed" ? { error: output ?? "Task failed" } : {}),
      ...(Object.keys(metadata).length ? { metadata } : {}),
    };
    try { this.context.store.updateSessionTask(durableTaskId, update); }
    catch (cause) {
      if (!isTerminalTaskStatus(status) || !repair || !persisted) throw cause;
      const error = cause instanceof Error ? { name: cause.name, message: cause.message } : { name: "Error", message: String(cause) };
      repair.createProjectionSettlement({ projector, rootSessionId: persisted.sessionId, eventSequence: 1,
        action: "retry-terminal-projection", payload: { execution: { ...structuredClone(task), status, output: output ?? "", metadata }, durableTaskId, cause: error }, error: error.message });
      this.context.log({ level: "error", event: "session.process_terminal.projection_failed", sessionId: persisted.sessionId, error: error.message });
    }
    this.context.events.publishSince(before);
    if (isTerminalTaskStatus(status)) this.untrackProcessExecution(runtime, task.id);
  }

  private processSettlementStore(): ProcessSettlementStore | undefined {
    const store = this.context.store;
    return store.createProjectionSettlement && store.listProjectionSettlements && store.markProjectionSettlementRetrying && store.resolveProjectionSettlement && store.failProjectionSettlement
      ? store as ProcessSettlementStore : undefined;
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

function isTerminalRuntimeStatus(status: string): boolean {
  return status === "completed" || status === "failed" || status === "stopped" || status === "interrupted";
}

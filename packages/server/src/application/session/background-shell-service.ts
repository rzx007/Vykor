import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { sessionSettingsRoot } from "../../runtime/session-settings-root.js";

import type { Settings } from "@vykor/core";
import type {
  ExecutionEnvironmentConsumer,
  ExecutionEnvironmentHandle,
  ShellDescriptor,
} from "@vykor/environment";
import type {
  SessionExecutionRecord,
  SessionRecord,
  SessionStatus,
  SessionTaskStatus,
} from "@vykor/protocol";

import type {
  DetachedProcessExecution,
  DetachedProcessSupervisor,
} from "@vykor/services/executions";

import type { SessionExecutionProjector } from "./session-execution-projector.js";
import type { SessionEventPublisher } from "./session-event-publisher.js";
import { ApplicationError } from "../../shared/application-error.js";
import type { DaemonOperationGate } from "../control/daemon-operation-gate.js";

type ProcessSupervisor = DetachedProcessSupervisor;
type TaskScope = { cwd: string; sessionId?: string };

export interface BackgroundShellSessionQueries {
  getSession(sessionId: string): SessionRecord | undefined;
  listSessions(options?: { includeArchived?: boolean }): Array<{
    id: string;
    cwd: string;
    status: SessionStatus;
  }>;
}

export interface BackgroundShellTaskOperations {
  listSessionTasks(sessionId: string): Array<{
    id: string;
    sessionId: string;
    type: string;
    status: string;
    output?: string;
    metadata: Record<string, unknown>;
  }>;
  getSessionTask(taskId: string): {
    id: string;
    sessionId: string;
    status?: string;
    output?: string;
    metadata: Record<string, unknown>;
  } | undefined;
  createSessionTask(input: {
    id: string;
    sessionId: string;
    type: string;
    description: string;
    cwd: string;
    metadata: Record<string, unknown>;
  }): unknown;
  reserveSessionTask(input: {
    id: string;
    sessionId: string;
    requestNamespace: string;
    requestId: string;
    type: string;
    description: string;
    cwd: string;
    metadata: Record<string, unknown>;
  }): { task: SessionExecutionRecord; created: boolean };
  transitionPendingSessionTask(taskId: string, input: {
    status?: SessionTaskStatus;
    output?: string;
    error?: string;
    metadata?: Record<string, unknown>;
  }): { task: SessionExecutionRecord; transitioned: boolean };
  updateSessionTask(taskId: string, input: {
    status?: SessionTaskStatus;
    output?: string;
    error?: string;
    metadata?: Record<string, unknown>;
  }): SessionExecutionRecord;
}

export interface BackgroundShellStore extends BackgroundShellSessionQueries, BackgroundShellTaskOperations {}

export class BackgroundShellError extends ApplicationError {
  constructor(
    status: 400 | 404 | 409,
    message: string,
  ) {
    super(status, message);
    this.name = "BackgroundShellError";
  }
}

export interface BackgroundShellServiceContext {
  operationGate?: Pick<DaemonOperationGate, "enter">;
  store: BackgroundShellStore;
  executionProjector: Pick<
    SessionExecutionProjector,
    "syncPersistentExecution" | "trackProcessExecution"
  >;
  getDetachedProcessSupervisor(scope: TaskScope): ProcessSupervisor;
  events: Pick<SessionEventPublisher, "checkpoint" | "publishSince">;
  getSettingsForCwd?(cwd: string): Promise<Settings>;
  acquireEnvironment?(
    session: SessionRecord,
    settings: Settings,
    consumer: ExecutionEnvironmentConsumer,
  ): Promise<ExecutionEnvironmentHandle>;
}

/** Shared background-shell creation and control for HTTP and model-tool callers. */
export class BackgroundShellService {
  private readonly sessions: BackgroundShellSessionQueries;
  private readonly tasks: BackgroundShellTaskOperations;

  private readonly starting = new Map<string, Promise<DetachedProcessExecution>>();
  private readonly environmentLeases = new Map<string, {
    lease: ExecutionEnvironmentHandle;
    unsubscribe: () => void;
  }>();

  constructor(private readonly context: BackgroundShellServiceContext) {
    this.sessions = context.store;
    this.tasks = context.store;
  }

  /** Reattach live process projections and terminalize rows whose runtime owner is gone. */
  async reconcileActiveTasks(reason = "Daemon restarted and the task runtime is unavailable"): Promise<number> {
    let reconciled = 0;
    const before = this.context.events.checkpoint();
    for (const session of this.sessions.listSessions({ includeArchived: true })) {
      const manager = this.context.getDetachedProcessSupervisor({
        cwd: session.cwd,
        sessionId: session.id,
      });
      for (const task of this.tasks.listSessionTasks(session.id)) {
        const isDetached = task.type === "shell" || task.metadata.executionBackend === "detached_process";
        const runtime = isDetached ? manager.getExecution(runtimeExecutionId(task)) : undefined;
        const active = task.status === "pending" || task.status === "running";
        if (!active) {
          if (runtime && (runtime.status === "pending" || runtime.status === "running")) {
            try {
              await manager.stopExecution(runtime.id);
              this.tasks.updateSessionTask(task.id, {
                metadata: { admissionPhase: "orphan_runtime_stopped" },
              });
            } catch (error) {
              this.tasks.updateSessionTask(task.id, {
                metadata: {
                  admissionPhase: "orphan_runtime_stop_failed",
                  reconciliationError: errorMessage(error),
                },
              });
            }
            reconciled += 1;
          }
          continue;
        }
        if (runtime) {
          this.context.executionProjector.trackProcessExecution(manager, runtime.id);
          this.context.executionProjector.syncPersistentExecution(runtime, manager, task.id);
          this.tasks.updateSessionTask(task.id, {
            metadata: { admissionPhase: "recovered_live" },
          });
        } else {
          this.tasks.updateSessionTask(task.id, {
            status: "interrupted",
            error: reason,
            metadata: { admissionPhase: "runtime_missing" },
          });
        }
        reconciled += 1;
      }
    }
    this.context.events.publishSince(before);
    return reconciled;
  }

  list(input: { cwd?: string; sessionId?: string; status?: string }): { executions: unknown[] } {
    const scope = this.resolveScope(input);
    const manager = this.context.getDetachedProcessSupervisor(scope);
    if (scope.sessionId) {
      const tasks = this.tasks.listSessionTasks(scope.sessionId);
      return { executions: input.status ? tasks.filter((task) => task.status === input.status) : tasks };
    }
    return { executions: manager.listExecutions(input.status) };
  }

  async create(input: {
    /** Stable identity for one logical creation request. */
    requestId: string;
    cwd?: string;
    sessionId?: string;
    command: string;
    description?: string;
    settings?: Settings;
    origin?: "http" | "tool";
    shellDescriptor?: ShellDescriptor;
    executionCwd?: string;
  }): Promise<{ execution: DetachedProcessExecution | SessionExecutionRecord; created: boolean }> {
    const scope = this.resolveScope(input, { requireActiveSession: true });
    const lease = scope.sessionId ? this.context.operationGate?.enter({ sessionId: scope.sessionId, cwd: scope.cwd }) : undefined;
    try { return await this.createInScope(input, scope); }
    finally { lease?.release(); }
  }

  private async createInScope(
    input: Parameters<BackgroundShellService["create"]>[0],
    scope: TaskScope,
  ): ReturnType<BackgroundShellService["create"]> {
    if (input.executionCwd !== undefined && (!scope.sessionId || !this.context.acquireEnvironment)) {
      throw new BackgroundShellError(400, "executionCwd requires an acquired session environment");
    }
    const requestId = input.requestId.trim();
    if (!requestId) throw new BackgroundShellError(400, "requestId is required");
    const command = input.command.trim();
    if (!command) throw new BackgroundShellError(400, "command is required");
    const description = input.description?.trim() || command;
    const manager = this.context.getDetachedProcessSupervisor(scope);
    if (!scope.sessionId) {
      const execution = await manager.startShellExecution({
        command,
        description,
        cwd: scope.cwd,
        ...(input.settings ? { settings: input.settings } : {}),
      });
      return { execution, created: true };
    }

    const requestNamespace = input.origin ?? "http";
    const requestFingerprint = shellRequestFingerprint({
      cwd: scope.cwd,
      command,
      description,
      settings: input.settings,
      executionCwd: input.executionCwd,
    });
    let eventCursor = this.context.events.checkpoint();
    const reservation = this.tasks.reserveSessionTask({
      id: `task_${randomUUID()}`,
      sessionId: scope.sessionId,
      requestNamespace,
      requestId,
      type: "shell",
      description,
      cwd: scope.cwd,
      metadata: {
        origin: requestNamespace,
        admissionPhase: "reserved",
        requestFingerprint,
        executionBackend: "detached_process",
      },
    });
    this.context.events.publishSince(eventCursor);
    eventCursor = this.context.events.checkpoint();
    if (!reservation.created) {
      if (reservation.task.metadata.requestFingerprint !== requestFingerprint) {
        throw new BackgroundShellError(409, `Background shell request identity conflict: ${requestId}`);
      }
      const starting = this.starting.get(reservation.task.id);
      if (starting) return { execution: await starting, created: false };
      const runtime = manager.getExecution(reservation.task.id);
      const admissionPhase = reservation.task.metadata.admissionPhase;
      if (runtime && (admissionPhase === "reserved" || admissionPhase === "dispatching")) {
        throw new BackgroundShellError(409, "Background shell startup owner is unavailable");
      }
      return { execution: runtime ?? reservation.task, created: false };
    }

    const starting = this.startReservedShell(input, scope as TaskScope & { sessionId: string }, manager, reservation.task.id, command, description, eventCursor);
    this.starting.set(reservation.task.id, starting);
    try { return { execution: await starting, created: true }; }
    finally { this.starting.delete(reservation.task.id); }
  }

  private async startReservedShell(
    input: { settings?: Settings; shellDescriptor?: ShellDescriptor; executionCwd?: string },
    scope: TaskScope & { sessionId: string },
    manager: ProcessSupervisor,
    taskId: string,
    command: string,
    description: string,
    eventCursor: number,
  ): Promise<DetachedProcessExecution> {
    this.tasks.updateSessionTask(taskId, {
      metadata: { admissionPhase: "dispatching" },
    });
    this.context.events.publishSince(eventCursor);
    eventCursor = this.context.events.checkpoint();
    let task: DetachedProcessExecution;
    let environmentLease: ExecutionEnvironmentHandle | undefined;
    let executionCwd: string | undefined;
    try {
      if (this.context.acquireEnvironment) {
        const session = this.sessions.getSession(scope.sessionId);
        if (!session) throw new BackgroundShellError(404, "Session not found");
        const settings = input.settings ?? await this.context.getSettingsForCwd?.(sessionSettingsRoot(session));
        if (!settings) throw new BackgroundShellError(400, "Background shell settings are required");
        environmentLease = await this.context.acquireEnvironment(
          session,
          settings,
          { kind: "background", id: taskId },
        );
        if (input.shellDescriptor && !sameShellDescriptor(
          input.shellDescriptor,
          environmentLease.info.shellDescriptor,
        )) {
          throw new BackgroundShellError(409, "Background shell no longer matches the owning session shell.");
        }
        const resolvedCwd = await environmentLease.paths.resolve(
          input.executionCwd ?? environmentLease.workspace.executionRoot, "execute",
        );
        if (resolvedCwd.mountPurpose !== "workspace") {
          throw new BackgroundShellError(409, "Background shell execution cwd is outside the workspace");
        }
        executionCwd = resolvedCwd.executionPath;
      }
      task = await manager.startShellExecution({
        id: taskId,
        command,
        description,
        cwd: scope.cwd,
        sessionId: scope.sessionId,
        ...(input.settings ? { settings: input.settings } : {}),
        ...(environmentLease ? {
          processExecutor: bindEnvironmentProcessExecutor(environmentLease, executionCwd),
        } : {}),
      });
    } catch (error) {
      await environmentLease?.release();
      this.tasks.transitionPendingSessionTask(taskId, {
        status: "failed",
        error: errorMessage(error),
        metadata: { admissionPhase: "failed" },
      });
      this.context.events.publishSince(eventCursor);
      throw error;
    }
    if (environmentLease) this.trackEnvironmentLease(manager, task, environmentLease);
    const confirmation = this.tasks.transitionPendingSessionTask(task.id, {
      status: processTaskStatus(task.status),
      metadata: {
        admissionPhase: "confirmed",
        runtimeExecutionId: task.id,
      },
    });
    if (!confirmation.transitioned && confirmation.task.status === "stopped" && task.status !== "stopped") {
      task = await manager.stopExecution(task.id);
      this.tasks.updateSessionTask(task.id, {
        metadata: { admissionPhase: "cancelled_before_start" },
      });
    }
    this.context.executionProjector.trackProcessExecution(manager, task.id);
    this.context.executionProjector.syncPersistentExecution(task, manager);
    this.context.events.publishSince(eventCursor);
    return task;
  }

  get(taskId: string, input: { cwd?: string; sessionId?: string }): { execution: unknown; output?: string } {
    const scope = this.resolveScope(input);
    const manager = this.context.getDetachedProcessSupervisor(scope);
    if (scope.sessionId) {
      const task = this.tasks.getSessionTask(taskId);
      if (!task || task.sessionId !== scope.sessionId) {
        throw new BackgroundShellError(404, `Task not found: ${taskId}`);
      }
      const managerTaskId = runtimeExecutionId(task);
      let output = task.output;
      try {
        output = manager.readOutput(managerTaskId);
      } catch {
        // Durable output remains available after a daemon restart.
      }
      return { execution: task, ...(output !== undefined ? { output } : {}) };
    }

    const task = manager.getExecution(taskId);
    if (!task) throw new BackgroundShellError(404, `Task not found: ${taskId}`);
    let output: string | undefined;
    try {
      output = manager.readOutput(taskId);
    } catch {
      output = undefined;
    }
    return { execution: task, ...(output !== undefined ? { output } : {}) };
  }

  async stop(taskId: string, input: { cwd?: string; sessionId?: string }): Promise<{ execution: unknown }> {
    const scope = this.resolveScope(input);
    const manager = this.context.getDetachedProcessSupervisor(scope);
    const persisted = scope.sessionId ? this.tasks.getSessionTask(taskId) : undefined;
    const managerTaskId = persisted ? runtimeExecutionId(persisted) : taskId;
    const task = await manager.stopExecution(managerTaskId);
    if (task.status !== "pending" && task.status !== "running") {
      await this.releaseEnvironmentLease(managerTaskId);
    }
    if (scope.sessionId && persisted) {
      this.context.executionProjector.syncPersistentExecution(task, manager, persisted.id);
    }
    return { execution: task };
  }

  private trackEnvironmentLease(
    manager: ProcessSupervisor,
    task: DetachedProcessExecution,
    lease: ExecutionEnvironmentHandle,
  ): void {
    const releaseIfTerminal = (execution: DetachedProcessExecution) => {
      if (execution.id !== task.id) return;
      if (execution.status === "pending" || execution.status === "running") return;
      void this.releaseEnvironmentLease(task.id);
    };
    const unsubscribe = manager.registerExecutionListener(releaseIfTerminal);
    this.environmentLeases.set(task.id, { lease, unsubscribe });
    releaseIfTerminal(task);
  }

  private async releaseEnvironmentLease(taskId: string): Promise<void> {
    const owned = this.environmentLeases.get(taskId);
    if (!owned) return;
    this.environmentLeases.delete(taskId);
    owned.unsubscribe();
    await owned.lease.release();
  }

  private resolveScope(
    input: { cwd?: string; sessionId?: string },
    options: { requireActiveSession?: boolean } = {},
  ): TaskScope {
    let cwd = input.cwd;
    if (input.sessionId) {
      const session = this.sessions.getSession(input.sessionId);
      if (!session) throw new BackgroundShellError(404, "Session not found");
      if (options.requireActiveSession && (session.status === "closing" || session.status === "archived")) {
        throw new BackgroundShellError(409, `Session is not accepting new work: ${input.sessionId}`);
      }
      if (cwd && resolve(cwd) !== resolve(session.cwd)) {
        throw new BackgroundShellError(409, "Background shell cwd mismatch");
      }
      // A session-scoped process is always owned by the supervisor for the session's
      // persisted cwd. Callers cannot move it into another supervisor namespace.
      cwd = session.cwd;
    }
    if (!cwd) throw new BackgroundShellError(400, "cwd or sessionId is required");
    return { cwd, ...(input.sessionId ? { sessionId: input.sessionId } : {}) };
  }
}

function bindEnvironmentProcessExecutor(environment: ExecutionEnvironmentHandle, cwd = environment.workspace.executionRoot) {
  return {
    execShell: (command: string, options = {}) =>
      environment.process.execShell(command, { ...options, cwd }),
    execProcess: (argv: string[], options = {}) =>
      environment.process.execProcess(argv, { ...options, cwd }),
  } satisfies typeof environment.process;
}

function sameShellDescriptor(
  expected: ShellDescriptor,
  actual: ShellDescriptor | undefined,
): boolean {
  return Boolean(actual
    && expected.family === actual.family
    && expected.dialect === actual.dialect
    && expected.executable === actual.executable
    && expected.argsPrefix.join("\0") === actual.argsPrefix.join("\0"));
}

function shellRequestFingerprint(input: {
  cwd: string;
  command: string;
  description: string;
  settings?: Settings;
  executionCwd?: string;
}): string {
  return createHash("sha256").update(stableJson(input)).digest("hex");
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

function processTaskStatus(status: DetachedProcessExecution["status"]): SessionTaskStatus {
  return status;
}

function runtimeExecutionId(task: { id: string; metadata: Record<string, unknown> }): string {
  if (typeof task.metadata.runtimeExecutionId === "string") return task.metadata.runtimeExecutionId;
  if (typeof task.metadata.taskManagerId === "string") return task.metadata.taskManagerId;
  return task.id;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

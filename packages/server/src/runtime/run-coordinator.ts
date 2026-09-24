import {
  AgentRunNotAcceptingInputError,
  type AgentRunHandle,
  type AgentSteerInput,
} from "@vykor/core";

export class RunInterruptedError extends Error {
  constructor(message = "Run interrupted") {
    super(message);
    this.name = "RunInterruptedError";
  }
}

export interface SessionRunWorkContext {
  signal: AbortSignal;
  registerHandle(handle: AgentRunHandle): Promise<void>;
}

export interface EnqueueRunOptions {
  sessionId: string;
  runId: string;
  work: (context: SessionRunWorkContext) => Promise<void>;
  onSteerRejected?(
    input: AgentSteerInput,
    error: AgentRunNotAcceptingInputError,
  ): string | Promise<string>;
}

export interface EnqueueRunResult {
  runId: string;
  sessionId: string;
  state: "running" | "queued";
  promise: Promise<void>;
}

export type SteerSessionResult =
  | { merged: false }
  | { merged: true; activeRunId: string; delivery: Promise<{ runId: string }> };

export type PromoteQueuedRunResult =
  | { promoted: false; reason: "active_run_changed" | "queued_run_changed" }
  | {
      promoted: true;
      activeRunId: string;
      queuedRunId: string;
      delivery: Promise<{ runId: string }>;
    };

export interface InterruptSessionResult {
  activeRunId?: string;
  queuedRunIds: string[];
  interrupted: boolean;
}

interface PendingSteerRequest {
  input: AgentSteerInput;
  recoverRejected: boolean;
  resolve(value: { runId: string }): void;
  reject(error: unknown): void;
}

interface RunTask {
  runId: string;
  sessionId: string;
  controller: AbortController;
  work: (context: SessionRunWorkContext) => Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
  promise: Promise<void>;
  handle?: AgentRunHandle;
  pendingSteers: PendingSteerRequest[];
  steerRequests: Set<PendingSteerRequest>;
  controlChain: Promise<void>;
  acceptingSteers: boolean;
  onSteerRejected?: EnqueueRunOptions["onSteerRejected"];
}

interface SessionLane {
  active?: RunTask;
  queue: RunTask[];
}

export class SessionRunCoordinator {
  private readonly lanes = new Map<string, SessionLane>();
  private readonly runPromises = new Map<string, Promise<void>>();

  enqueue(options: EnqueueRunOptions): EnqueueRunResult {
    const lane = this.getLane(options.sessionId);
    const task = this.createTask(options);
    const state = lane.active ? "queued" : "running";
    if (lane.active) lane.queue.push(task);
    else this.startTask(lane, task);
    const promise = task.promise.finally(() => {
      if (this.runPromises.get(task.runId) === promise) this.runPromises.delete(task.runId);
    });
    void promise.catch(() => {});
    this.runPromises.set(task.runId, promise);
    return {
      runId: task.runId,
      sessionId: task.sessionId,
      state,
      promise,
    };
  }

  runState(sessionId: string, runId: string): "running" | "queued" | undefined {
    if (!this.runPromises.has(runId)) return undefined;
    return this.activeRunId(sessionId) === runId ? "running" : "queued";
  }

  async waitForRun(runId: string): Promise<void> {
    await this.runPromises.get(runId);
  }

  async waitForRuns(runIds: string[]): Promise<void> {
    await Promise.all(runIds.map((runId) => this.runPromises.get(runId)).filter((promise): promise is Promise<void> => promise !== undefined));
  }

  trackRunCompletion(runId: string, promise: Promise<void>): void {
    if (!this.runPromises.has(runId)) return;
    const completion = promise.finally(() => {
      if (this.runPromises.get(runId) === completion) this.runPromises.delete(runId);
    });
    this.runPromises.set(runId, completion);
    void completion.catch(() => {});
  }

  steer(
    sessionId: string,
    input: AgentSteerInput,
    options: { recoverRejected?: boolean } = {},
  ): SteerSessionResult {
    const lane = this.lanes.get(sessionId);
    if (!lane?.active || !lane.active.acceptingSteers) return { merged: false };
    let resolve!: PendingSteerRequest["resolve"];
    let reject!: PendingSteerRequest["reject"];
    const delivery = new Promise<{ runId: string }>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    void delivery.catch(() => {});
    const request = {
      input,
      recoverRejected: options.recoverRejected ?? true,
      resolve,
      reject,
    };
    lane.active.pendingSteers.push(request);
    lane.active.steerRequests.add(request);
    this.flushSteers(lane.active);
    return { merged: true, activeRunId: lane.active.runId, delivery };
  }

  promoteQueuedRun(
    sessionId: string,
    queuedRunId: string,
    expectedActiveRunId: string,
    input: AgentSteerInput,
  ): PromoteQueuedRunResult {
    const lane = this.lanes.get(sessionId);
    if (
      !lane?.active ||
      lane.active.runId !== expectedActiveRunId ||
      !lane.active.acceptingSteers
    ) {
      return { promoted: false, reason: "active_run_changed" };
    }
    const queuedIndex = lane.queue.findIndex(
      (task) => task.runId === queuedRunId,
    );
    if (queuedIndex < 0) {
      return { promoted: false, reason: "queued_run_changed" };
    }
    const queuedTask = lane.queue.splice(queuedIndex, 1)[0]!;
    const steered = this.steer(sessionId, input, { recoverRejected: false });
    if (!steered.merged || steered.activeRunId !== expectedActiveRunId) {
      this.restoreQueuedTask(lane, queuedTask, queuedIndex);
      return { promoted: false, reason: "active_run_changed" };
    }
    const delivery = steered.delivery
      .then((receipt) => {
        if (receipt.runId !== expectedActiveRunId) {
          throw new Error(
            `Steer was delivered to an unexpected run: ${receipt.runId}`,
          );
        }
        this.rejectQueuedTask(
          queuedTask,
          "Queued run promoted into the active run",
        );
        return receipt;
      })
      .catch((error) => {
        this.restoreQueuedTask(lane, queuedTask, queuedIndex);
        throw error;
      });
    void delivery.catch(() => {});
    return {
      promoted: true,
      activeRunId: expectedActiveRunId,
      queuedRunId,
      delivery,
    };
  }

  interrupt(sessionId: string, reason?: string): InterruptSessionResult {
    const lane = this.lanes.get(sessionId);
    if (!lane) return { queuedRunIds: [], interrupted: false };

    const queuedRunIds = lane.queue.map((task) => task.runId);
    for (const task of lane.queue.splice(0)) {
      const message = reason ?? "Queued run interrupted";
      const error = new RunInterruptedError(message);
      task.controller.abort(message);
      this.rejectSteers(task, error);
      task.reject(error);
    }

    const activeRunId = lane.active?.runId;
    if (lane.active) {
      const message = reason ?? "Run interrupted";
      this.rejectSteers(
        lane.active,
        new RunInterruptedError(reason ?? "Steered input interrupted"),
      );
      lane.active.controller.abort(message);
      void lane.active.handle?.interrupt(message);
    }
    return {
      ...(activeRunId ? { activeRunId } : {}),
      queuedRunIds,
      interrupted: !!activeRunId || queuedRunIds.length > 0,
    };
  }

  interruptRun(
    sessionId: string,
    runId: string,
    reason?: string,
  ): InterruptSessionResult {
    const lane = this.lanes.get(sessionId);
    if (!lane) return { queuedRunIds: [], interrupted: false };

    if (lane.active?.runId === runId) {
      const message = reason ?? "Run interrupted";
      this.rejectSteers(
        lane.active,
        new RunInterruptedError(reason ?? "Steered input interrupted"),
      );
      lane.active.controller.abort(message);
      void lane.active.handle?.interrupt(message);
      return { activeRunId: runId, queuedRunIds: [], interrupted: true };
    }

    const queuedIndex = lane.queue.findIndex((task) => task.runId === runId);
    if (queuedIndex >= 0) {
      const [task] = lane.queue.splice(queuedIndex, 1);
      if (task) {
        const message = reason ?? "Queued run interrupted";
        const error = new RunInterruptedError(message);
        task.controller.abort(message);
        this.rejectSteers(task, error);
        task.reject(error);
      }
      return {
        ...(lane.active ? { activeRunId: lane.active.runId } : {}),
        queuedRunIds: [runId],
        interrupted: true,
      };
    }

    return {
      ...(lane.active ? { activeRunId: lane.active.runId } : {}),
      queuedRunIds: [],
      interrupted: false,
    };
  }

  interruptQueuedRun(
    sessionId: string,
    runId: string,
    reason?: string,
  ): InterruptSessionResult {
    const lane = this.lanes.get(sessionId);
    if (!lane) return { queuedRunIds: [], interrupted: false };
    const queuedIndex = lane.queue.findIndex((task) => task.runId === runId);
    if (queuedIndex < 0) {
      return {
        ...(lane.active ? { activeRunId: lane.active.runId } : {}),
        queuedRunIds: [],
        interrupted: false,
      };
    }
    const [task] = lane.queue.splice(queuedIndex, 1);
    if (task) this.rejectQueuedTask(task, reason ?? "Queued run interrupted");
    return {
      ...(lane.active ? { activeRunId: lane.active.runId } : {}),
      queuedRunIds: [runId],
      interrupted: true,
    };
  }

  activeRunId(sessionId: string): string | undefined {
    return this.lanes.get(sessionId)?.active?.runId;
  }

  queuedRunIds(sessionId: string): string[] {
    return [...(this.lanes.get(sessionId)?.queue ?? [])].map(
      (task) => task.runId,
    );
  }

  hasWork(sessionId: string): boolean {
    const lane = this.lanes.get(sessionId);
    return !!lane?.active || (lane?.queue.length ?? 0) > 0;
  }

  sessionIds(): string[] {
    return [...this.lanes.keys()];
  }

  private getLane(sessionId: string): SessionLane {
    let lane = this.lanes.get(sessionId);
    if (!lane) {
      lane = { queue: [] };
      this.lanes.set(sessionId, lane);
    }
    return lane;
  }

  private rejectQueuedTask(task: RunTask, message: string): void {
    const error = new RunInterruptedError(message);
    task.controller.abort(message);
    this.rejectSteers(task, error);
    task.reject(error);
  }

  private restoreQueuedTask(
    lane: SessionLane,
    task: RunTask,
    preferredIndex: number,
  ): void {
    this.lanes.set(task.sessionId, lane);
    if (lane.active) {
      lane.queue.splice(Math.min(preferredIndex, lane.queue.length), 0, task);
      return;
    }
    this.startTask(lane, task);
  }

  private createTask(options: EnqueueRunOptions): RunTask {
    const controller = new AbortController();
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return {
      runId: options.runId,
      sessionId: options.sessionId,
      controller,
      work: options.work,
      resolve,
      reject,
      promise,
      pendingSteers: [],
      steerRequests: new Set(),
      controlChain: Promise.resolve(),
      acceptingSteers: true,
      onSteerRejected: options.onSteerRejected,
    };
  }

  private startTask(lane: SessionLane, task: RunTask): void {
    lane.active = task;
    void (async () => {
      try {
        if (task.controller.signal.aborted) throw new RunInterruptedError();
        await task.work({
          signal: task.controller.signal,
          registerHandle: async (handle) => {
            if (task.controller.signal.aborted) {
              const message = abortReason(
                task.controller.signal,
                "Run interrupted",
              );
              await handle.interrupt(message);
              throw new RunInterruptedError(message);
            }
            task.handle = handle;
            this.flushSteers(task);
            await task.controlChain;
          },
        });
        task.acceptingSteers = false;
        await task.controlChain;
        await this.recoverUndeliveredSteers(task);
        task.resolve();
      } catch (error) {
        task.acceptingSteers = false;
        this.rejectSteers(task, error);
        task.reject(error);
      } finally {
        if (lane.active === task) lane.active = undefined;
        const next = lane.queue.shift();
        if (next) this.startTask(lane, next);
        else if (!lane.active) this.lanes.delete(task.sessionId);
      }
    })();
  }

  private flushSteers(task: RunTask): void {
    if (!task.handle || task.pendingSteers.length === 0) return;
    const pending = task.pendingSteers.splice(0);
    task.controlChain = task.controlChain
      .then(async () => {
        for (const request of pending) {
          try {
            const receipt = await task.handle!.steer(request.input);
            request.resolve({ runId: receipt.runId });
          } catch (error) {
            if (task.controller.signal.aborted) {
              const interrupted = new RunInterruptedError(
                "Steered input interrupted",
              );
              request.reject(interrupted);
              throw interrupted;
            }
            if (error instanceof AgentRunNotAcceptingInputError) {
              if (!request.recoverRejected || !task.onSteerRejected) {
                request.reject(error);
                continue;
              }
            } else {
              request.reject(error);
              throw error;
            }
            try {
              const runId = await task.onSteerRejected(request.input, error);
              request.resolve({ runId });
            } catch (replacementError) {
              request.reject(replacementError);
              throw replacementError;
            }
          } finally {
            task.steerRequests.delete(request);
          }
        }
      })
      .catch((error) => {
        task.controller.abort(error);
        void task.handle?.interrupt(
          error instanceof Error ? error.message : String(error),
        );
        throw error;
      });
    void task.controlChain.catch(() => {});
  }

  private rejectSteers(task: RunTask, error: unknown): void {
    for (const request of task.steerRequests) request.reject(error);
    task.steerRequests.clear();
    task.pendingSteers.splice(0);
  }

  private async recoverUndeliveredSteers(task: RunTask): Promise<void> {
    const pending = task.pendingSteers.splice(0);
    if (pending.length === 0) return;
    if (task.controller.signal.aborted) {
      const error = new RunInterruptedError("Steered input interrupted");
      for (const request of pending) {
        request.reject(error);
        task.steerRequests.delete(request);
      }
      return;
    }
    const error = new AgentRunNotAcceptingInputError(task.runId);
    for (const request of pending) {
      try {
        if (!request.recoverRejected || !task.onSteerRejected) {
          request.reject(error);
          continue;
        }
        const runId = await task.onSteerRejected(request.input, error);
        request.resolve({ runId });
      } catch (replacementError) {
        request.reject(replacementError);
        throw replacementError;
      } finally {
        task.steerRequests.delete(request);
      }
    }
  }
}

function abortReason(signal: AbortSignal, fallback: string): string {
  if (typeof signal.reason === "string" && signal.reason) return signal.reason;
  if (signal.reason instanceof Error && signal.reason.message)
    return signal.reason.message;
  return fallback;
}

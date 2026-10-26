import type { SessionRunRecord } from "@vykor/domain-contracts/sessions";

import { SessionRunCoordinator, type EnqueueRunOptions } from "../../../runtime/run-coordinator.js";
import type { SessionRunExecutor } from "./session-run-executor.js";
import type { SessionEventPublisher } from "../transcript/session-event-publisher.js";

export interface SessionRunEngineContext {
  runExecutor: Pick<SessionRunExecutor, "execute">;
  events: Pick<SessionEventPublisher, "checkpoint" | "publishSince">;
  execution: {
    prepareRunExecution(runId: string): boolean;
    recoverRejectedSteer(sessionId: string, input: Parameters<SessionRunCoordinator["steer"]>[1]): string | Promise<string>;
  };
  settleGoalRun?(sessionId: string, runId: string): Promise<void>;
}

/** Owns only the in-memory per-session run lanes and their execution lifecycle. */
export class SessionRunEngine {
  private readonly runCoordinator = new SessionRunCoordinator();

  readonly runtimeBridge = {
    activeRunId: this.runCoordinator.activeRunId.bind(this.runCoordinator),
    queuedRunIds: this.runCoordinator.queuedRunIds.bind(this.runCoordinator),
    hasWork: this.runCoordinator.hasWork.bind(this.runCoordinator),
    sessionIds: this.runCoordinator.sessionIds.bind(this.runCoordinator),
    interruptSession: this.runCoordinator.interrupt.bind(this.runCoordinator),
    interruptRun: this.runCoordinator.interruptRun.bind(this.runCoordinator),
    interruptQueuedRun: this.runCoordinator.interruptQueuedRun.bind(this.runCoordinator),
    promoteQueuedRun: this.runCoordinator.promoteQueuedRun.bind(this.runCoordinator),
    waitForRun: this.runCoordinator.waitForRun.bind(this.runCoordinator),
    waitForRuns: this.runCoordinator.waitForRuns.bind(this.runCoordinator),
    enqueueRun: this.enqueueRun.bind(this),
    runState: this.runCoordinator.runState.bind(this.runCoordinator),
    steer: this.runCoordinator.steer.bind(this.runCoordinator),
  };

  constructor(private readonly context: SessionRunEngineContext) {}

  /** Independent host work shares cancellation and ordering, without model/Goal settlement. */
  enqueueHostWork(options: Pick<EnqueueRunOptions, "sessionId" | "runId" | "work">): "running" | "queued" {
    return this.runCoordinator.enqueue({ ...options, acceptsSteers: false }).state;
  }

  private enqueueRun(run: SessionRunRecord, inputId: string): "running" | "queued" {
    const enqueued = this.runCoordinator.enqueue({
      sessionId: run.sessionId,
      runId: run.id,
      work: async (workContext) => {
        await Promise.resolve();
        const beforeStart = this.context.events.checkpoint();
        if (!this.context.execution.prepareRunExecution(run.id)) {
          this.context.events.publishSince(beforeStart);
          return;
        }
        this.context.events.publishSince(beforeStart);
        await this.context.runExecutor.execute({ sessionId: run.sessionId, inputId, runId: run.id }, workContext);
      },
      onSteerRejected: (input) => this.context.execution.recoverRejectedSteer(run.sessionId, input),
    });
    const tracked = enqueued.promise.catch(() => {}).finally(async () => this.context.settleGoalRun?.(run.sessionId, run.id));
    void tracked.catch(() => {});
    this.runCoordinator.trackRunCompletion(run.id, tracked);
    return enqueued.state;
  }
}

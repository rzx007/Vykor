import type { SessionRunRecord } from "@vykor/protocol";

import { SessionRunCoordinator } from "../../runtime/run-coordinator.js";
import type { SessionRunExecutor } from "./session-run-executor.js";
import type { SessionEventPublisher } from "./session-event-publisher.js";

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
    activeRunId: (sessionId: string) => this.runCoordinator.activeRunId(sessionId),
    queuedRunIds: (sessionId: string) => this.runCoordinator.queuedRunIds(sessionId),
    hasWork: (sessionId: string) => this.runCoordinator.hasWork(sessionId),
    sessionIds: () => this.runCoordinator.sessionIds(),
    interruptSession: (sessionId: string, reason?: string) => this.runCoordinator.interrupt(sessionId, reason),
    interruptRun: (sessionId: string, runId: string, reason?: string) => this.runCoordinator.interruptRun(sessionId, runId, reason),
    interruptQueuedRun: (sessionId: string, runId: string, reason?: string) => this.runCoordinator.interruptQueuedRun(sessionId, runId, reason),
    promoteQueuedRun: (sessionId: string, queuedRunId: string, expectedActiveRunId: string, steer: Parameters<SessionRunCoordinator["promoteQueuedRun"]>[3]) =>
      this.runCoordinator.promoteQueuedRun(sessionId, queuedRunId, expectedActiveRunId, steer),
    waitForRun: (runId: string) => this.runCoordinator.waitForRun(runId),
    waitForRuns: (runIds: string[]) => this.runCoordinator.waitForRuns(runIds),
    enqueueRun: (run: SessionRunRecord, inputId: string) => this.enqueueRun(run, inputId),
    runState: (sessionId: string, runId: string): "running" | "queued" | undefined => this.runCoordinator.runState(sessionId, runId),
    steer: (sessionId: string, input: Parameters<SessionRunCoordinator["steer"]>[1]) => this.runCoordinator.steer(sessionId, input),
  };

  constructor(private readonly context: SessionRunEngineContext) {}

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

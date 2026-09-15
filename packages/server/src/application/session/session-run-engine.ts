import type {
  AdmitPromptAttachmentInput,
  AttachmentLimits,
  ReplaceTranscriptMessageInput,
  SessionRunRecord,
  SessionUserInputItem,
} from "@openharness/protocol";
import {
  type SessionStore,
  type GoalOperations,
} from "@openharness/services";

import {
  RunInterruptedError,
  SessionRunCoordinator,
} from "../../runtime/run-coordinator.js";
import type { SessionRunExecutor } from "./session-run-executor.js";
import type { SessionEventPublisher } from "./session-event-publisher.js";
import type { AgentPool } from "../agent/agent-pool.js";
import {
  RunAdmissionService,
  type AdmitPromptInput,
  type AdmitPromptResult,
} from "./run-admission-service.js";
import {
  RunControlService,
  type AwaitSessionRunResult,
  type PromoteQueuedRunResult,
} from "./run-control-service.js";

export type { AdmitPromptInput, AdmitPromptResult, AwaitSessionRunResult, PromoteQueuedRunResult };

export interface SessionRunEngineContext {
  store: SessionStore;
  goals: Pick<
    GoalOperations,
    | "getCurrentGoal"
    | "getGoal"
    | "updateGoal"
    | "markGoalContinuation"
    | "startGoalRun"
  >;
  agentPool: AgentPool;
  runExecutor: Pick<SessionRunExecutor, "execute">;
  events: Pick<SessionEventPublisher, "checkpoint" | "publishSince">;
  attachmentLimits?: AttachmentLimits;
  settleGoalRun?(sessionId: string, runId: string): Promise<void>;
  materializeSteerInput?(
    sessionId: string,
    items: readonly SessionUserInputItem[],
  ): Promise<string>;
  admission?: RunAdmissionService;
  control?: RunControlService;
}

/**
 * Prompt 准入与 session lane 调度（不执行模型）。
 * 负责 admit/steer/queue、创建 run、enqueue 到 SessionRunCoordinator，
 * 以及 awaitRun / interrupt；真正跑模型交给 SessionRunExecutor。
 */
export class SessionRunEngine {
  private readonly runCoordinator = new SessionRunCoordinator();
  private readonly runPromises = new Map<string, Promise<void>>();
  private accepting = true;
  private stopPromise?: Promise<void>;
  private readonly admissionService: RunAdmissionService;
  private readonly controlService: RunControlService;

  constructor(private readonly context: SessionRunEngineContext) {
    this.controlService =
      context.control ??
      new RunControlService({
        durableSessions: context.store,
        durableRuns: context.store,
        durableInputs: context.store,
        runtime: {
          activeRunId: (sId) => this.runCoordinator.activeRunId(sId),
          queuedRunIds: (sId) => this.runCoordinator.queuedRunIds(sId),
          hasWork: (sId) => this.runCoordinator.hasWork(sId),
          sessionIds: () => this.runCoordinator.sessionIds(),
          interruptSession: (sId, r) => this.runCoordinator.interrupt(sId, r),
          interruptRun: (sId, rId, r) => this.runCoordinator.interruptRun(sId, rId, r),
          interruptQueuedRun: (sId, rId, r) => this.runCoordinator.interruptQueuedRun(sId, rId, r),
          promoteQueuedRun: (sId, qId, exp, steer) =>
            this.runCoordinator.promoteQueuedRun(sId, qId, exp, steer),
          waitForRun: async (rId) => {
            const p = this.runPromises.get(rId);
            if (p) await p;
          },
          waitForRuns: async (rIds) => {
            await Promise.all(
              rIds
                .map((rId) => this.runPromises.get(rId))
                .filter((p): p is Promise<void> => p !== undefined),
            );
          },
        },
        events: context.events,
        goals: context.goals,
        materializeSteerInput: context.materializeSteerInput,
      });

    this.admissionService =
      context.admission ??
      new RunAdmissionService({
        conversationTransactions: context.store,
        runOperations: context.store,
        runtimeQueue: {
          hasRuntime: context.agentPool.configured,
          enqueueRun: (run, inputId) => this.enqueueRun(run, inputId),
          runState: (sessionId, runId) => {
            if (!this.runPromises.has(runId)) return undefined;
            return this.runCoordinator.activeRunId(sessionId) === runId ? "running" : "queued";
          },
          steer: (sId, input) => this.runCoordinator.steer(sId, input),
        },
        events: context.events,
        attachmentLimits: context.attachmentLimits,
        goals: {
          getCurrentGoal: (sId) => context.goals.getCurrentGoal(sId),
          getGoal: (goalId) => context.goals.getGoal(goalId),
          startGoalRun: (goalId, revision, runId, continuation) =>
            context.goals.startGoalRun(goalId, revision, runId, continuation),
          markGoalContinuation: (runId, status) => context.goals.markGoalContinuation(runId, status),
          hasUserWork: (sessionId) => this.controlService.hasUserWork(sessionId),
          cancelGoalRuns: (sId, gId, r, queuedOnly) =>
            this.controlService.cancelGoalRuns(sId, gId, r, queuedOnly),
        },
        materializer: context.materializeSteerInput
          ? { materializeSteerInput: context.materializeSteerInput }
          : undefined,
      });
  }

  get admission(): RunAdmissionService {
    return this.admissionService;
  }

  get control(): RunControlService {
    return this.controlService;
  }

  persistGoalRun(sessionId: string, input: AdmitPromptInput) {
    if (!this.accepting) throw new Error("Session run engine is stopping");
    return this.admissionService.persistGoalRun(sessionId, input);
  }

  dispatchPersistedRun(runId: string): "running" | "queued" | undefined {
    return this.admissionService.dispatchPersistedRun(runId);
  }

  hasUserWork(sessionId: string): boolean {
    return this.admissionService.hasPendingAdmission(sessionId) || this.controlService.hasUserWork(sessionId);
  }

  cancelGoalRuns(sessionId: string, goalId: string, reason: string, queuedOnly = false): string[] {
    return this.controlService.cancelGoalRuns(sessionId, goalId, reason, queuedOnly);
  }

  activeRunId(sessionId: string): string | undefined {
    return this.controlService.activeRunId(sessionId);
  }

  queuedRunIds(sessionId: string): string[] {
    return this.controlService.queuedRunIds(sessionId);
  }

  hasWork(sessionId: string): boolean {
    return this.controlService.hasWork(sessionId);
  }

  async promoteQueuedRun(
    sessionId: string,
    inputId: string,
    queuedRunId: string,
    expectedActiveRunId: string,
  ): Promise<PromoteQueuedRunResult | undefined> {
    if (!this.accepting) throw new Error("Session run engine is stopping");
    return await this.controlService.promoteQueuedRun(sessionId, inputId, queuedRunId, expectedActiveRunId);
  }

  hasAnyActiveRuns(): boolean {
    return this.controlService.hasAnyActiveRuns();
  }

  replaceTranscriptAndAdmitPrompt(
    sessionId: string,
    messages: ReplaceTranscriptMessageInput[],
    input: Omit<AdmitPromptInput, "delivery">,
  ): AdmitPromptResult {
    if (!this.accepting) throw new Error("Session run engine is stopping");
    return this.admissionService.replaceTranscriptAndAdmitPrompt(sessionId, messages, input);
  }

  replaceLatestPrompt(
    sessionId: string,
    sourceMessageId: string,
    input: Omit<AdmitPromptInput, "delivery">,
  ): AdmitPromptResult {
    if (!this.accepting) throw new Error("Session run engine is stopping");
    return this.admissionService.replaceLatestPrompt(sessionId, sourceMessageId, input);
  }

  replayInput(
    inputId: string,
    input: { id?: string; metadata?: Record<string, unknown>; traceId?: string },
  ): AdmitPromptResult {
    if (!this.accepting) throw new Error("Session run engine is stopping");
    return this.admissionService.replayInput(inputId, input);
  }

  hasActiveRunsForCwd(cwd: string): boolean {
    return this.controlService.hasActiveRunsForCwd(cwd);
  }

  async stopAndDrain(reason = "Daemon shutting down"): Promise<void> {
    if (this.stopPromise) return await this.stopPromise;
    this.accepting = false;
    this.admissionService.stop();
    const stopping = (async () => {
      const runIds: string[] = [];
      for (const sessionId of this.runCoordinator.sessionIds()) {
        const interrupted = this.interruptSession(sessionId, reason);
        if (interrupted.activeRunId) runIds.push(interrupted.activeRunId);
        runIds.push(...interrupted.queuedRunIds);
      }
      await this.waitForRuns(runIds);
    })();
    this.stopPromise = stopping;
    await stopping;
  }

  async awaitRun(
    sessionId: string,
    runId: string,
  ): Promise<AwaitSessionRunResult> {
    return await this.controlService.awaitRun(sessionId, runId);
  }

  async waitForRuns(runIds: string[]): Promise<void> {
    await this.controlService.waitForRuns(runIds);
  }

  admitPromptAndMaybeRun(
    sessionId: string,
    input: AdmitPromptInput,
  ): Promise<AdmitPromptResult> {
    if (!this.accepting) {
      return Promise.reject(new Error("Session run engine is stopping"));
    }
    return this.admissionService.admitPromptAndMaybeRun(sessionId, input);
  }

  interruptSession(
    sessionId: string,
    reason?: string,
  ): ReturnType<SessionRunCoordinator["interrupt"]> {
    return this.controlService.interruptSession(sessionId, reason);
  }

  interruptRun(
    sessionId: string,
    runId: string,
    reason?: string,
  ): ReturnType<SessionRunCoordinator["interruptRun"]> {
    return this.controlService.interruptRun(sessionId, runId, reason);
  }

  interruptQueuedRun(
    sessionId: string,
    runId: string,
    reason?: string,
  ): ReturnType<SessionRunCoordinator["interruptQueuedRun"]> {
    return this.controlService.interruptQueuedRun(sessionId, runId, reason);
  }

  private enqueueRun(
    run: SessionRunRecord,
    inputId: string,
  ): "running" | "queued" {
    const enqueued = this.runCoordinator.enqueue({
      sessionId: run.sessionId,
      runId: run.id,
      work: async (workContext) => {
        // Let enqueue register the promise before execution can settle or be interrupted.
        await Promise.resolve();
        const beforeStart = this.context.events.checkpoint();
        if (!this.admissionService.prepareRunExecution(run.id)) {
          this.context.events.publishSince(beforeStart);
          return;
        }
        this.context.events.publishSince(beforeStart);
        await this.context.runExecutor.execute(
          {
            sessionId: run.sessionId,
            inputId,
            runId: run.id,
          },
          workContext,
        );
      },
      onSteerRejected: (input) =>
        this.admissionService.recoverRejectedSteer(run.sessionId, input),
    });
    const tracked = enqueued.promise
      .catch(() => {
        // The persisted run state is updated by SessionRunExecutor or interrupt handling.
      })
      .finally(async () => {
        if (this.runPromises.get(run.id) === tracked)
          this.runPromises.delete(run.id);
        await this.context.settleGoalRun?.(run.sessionId, run.id);
      });
    void tracked.catch(() => {});
    this.runPromises.set(run.id, tracked);
    return enqueued.state;
  }

}

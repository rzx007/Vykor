import type { AttachmentLimits, SessionUserInputItem } from "@openharness/protocol";
import type { GoalOperations, SessionStore } from "@openharness/services";
import type { AgentPool } from "../agent/agent-pool.js";
import type { SessionEventPublisher } from "./session-event-publisher.js";
import { RunAdmissionService } from "./run-admission-service.js";
import { RunControlService } from "./run-control-service.js";
import { SessionRunEngine } from "./session-run-engine.js";
import type { SessionRunExecutor } from "./session-run-executor.js";

export interface SessionRunAssemblyOptions {
  store: SessionStore;
  goals: GoalOperations;
  agentPool: AgentPool;
  runExecutor: Pick<SessionRunExecutor, "execute">;
  events: Pick<SessionEventPublisher, "checkpoint" | "publishSince">;
  attachmentLimits?: AttachmentLimits;
  materializeSteerInput(sessionId: string, items: readonly SessionUserInputItem[]): Promise<string>;
  assertReady(): void;
  settleGoalRun(sessionId: string, runId: string): Promise<void>;
}

/** Explicit two-phase wiring for the one shared Admission, Control and compatibility Engine trio. */
export function assembleSessionRunServices(options: SessionRunAssemblyOptions): {
  admission: RunAdmissionService;
  control: RunControlService;
  engine: SessionRunEngine;
} {
  let engine!: SessionRunEngine;
  let admission!: RunAdmissionService;
  const control = new RunControlService({
    durableSessions: options.store,
    durableRuns: options.store,
    durableInputs: options.store,
    runtime: {
      activeRunId: (sessionId) => engine.runtimeBridge.activeRunId(sessionId),
      queuedRunIds: (sessionId) => engine.runtimeBridge.queuedRunIds(sessionId),
      hasWork: (sessionId) => engine.runtimeBridge.hasWork(sessionId),
      sessionIds: () => engine.runtimeBridge.sessionIds(),
      interruptSession: (sessionId, reason) => engine.runtimeBridge.interruptSession(sessionId, reason),
      interruptRun: (sessionId, runId, reason) => engine.runtimeBridge.interruptRun(sessionId, runId, reason),
      interruptQueuedRun: (sessionId, runId, reason) => engine.runtimeBridge.interruptQueuedRun(sessionId, runId, reason),
      promoteQueuedRun: (sessionId, queuedRunId, activeRunId, steer) => engine.runtimeBridge.promoteQueuedRun(sessionId, queuedRunId, activeRunId, steer),
      waitForRun: (runId) => engine.runtimeBridge.waitForRun(runId),
      waitForRuns: (runIds) => engine.runtimeBridge.waitForRuns(runIds),
    },
    events: options.events,
    goals: options.goals,
    admission: { hasPendingAdmission: (sessionId) => admission.hasPendingAdmission(sessionId) },
    materializeSteerInput: options.materializeSteerInput,
  });
  admission = new RunAdmissionService({
    sessionQueries: options.store,
    conversationTransactions: options.store,
    runOperations: options.store,
    runtimeQueue: {
      hasRuntime: options.agentPool.configured,
      enqueueRun: (run, inputId) => engine.runtimeBridge.enqueueRun(run, inputId),
      runState: (sessionId, runId) => engine.runtimeBridge.runState(sessionId, runId),
      steer: (sessionId, input) => engine.runtimeBridge.steer(sessionId, input),
    },
    events: options.events,
    attachmentLimits: options.attachmentLimits,
    goals: {
      getCurrentGoal: (sessionId) => options.goals.getCurrentGoal(sessionId),
      getGoal: (goalId) => options.goals.getGoal(goalId),
      startGoalRun: (goalId, revision, runId, continuation) => options.goals.startGoalRun(goalId, revision, runId, continuation),
      markGoalContinuation: (runId, status) => options.goals.markGoalContinuation(runId, status),
      hasUserWork: (sessionId) => control.hasUserWork(sessionId),
      cancelGoalRuns: (sessionId, goalId, reason, queuedOnly) => control.cancelGoalRuns(sessionId, goalId, reason, queuedOnly),
    },
    materializer: { materializeSteerInput: options.materializeSteerInput },
    assertReady: options.assertReady,
  });
  engine = new SessionRunEngine({
    store: options.store,
    goals: options.goals,
    agentPool: options.agentPool,
    runExecutor: options.runExecutor,
    events: options.events,
    attachmentLimits: options.attachmentLimits,
    materializeSteerInput: options.materializeSteerInput,
    settleGoalRun: options.settleGoalRun,
    admission,
    control,
  });
  return { admission, control, engine };
}

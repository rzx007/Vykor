import type { AttachmentLimits, SessionUserInputItem } from "@openharness/protocol";
import type { GoalOperations, SessionStore } from "@openharness/services";
import type { AgentPool } from "../agent/agent-pool.js";
import type { SessionEventPublisher } from "./session-event-publisher.js";
import { RunAdmissionService } from "./run-admission-service.js";
import { RunControlService } from "./run-control-service.js";
import { SessionRunEngine } from "./session-run-engine.js";
import type { SessionRunExecutor } from "./session-run-executor.js";

export interface SessionRunAssemblyOptions {
  store: Pick<SessionStore, "conversations" | "conversationTransactions" | "runs" | "sessions" | "transaction">;
  goals: GoalOperations;
  agentPool: AgentPool;
  runExecutor: Pick<SessionRunExecutor, "execute">;
  events: Pick<SessionEventPublisher, "checkpoint" | "publishSince">;
  attachmentLimits?: AttachmentLimits;
  materializeSteerInput(sessionId: string, items: readonly SessionUserInputItem[]): Promise<string>;
  assertReady(): void;
  settleGoalRun(sessionId: string, runId: string): Promise<void>;
}

/** Explicit two-phase wiring for the shared lane runtime, Admission and Control services. */
export function assembleSessionRunServices(options: SessionRunAssemblyOptions): {
  admission: RunAdmissionService;
  control: RunControlService;
  engine: SessionRunEngine;
} {
  let engine!: SessionRunEngine;
  let admission!: RunAdmissionService;
  const transaction = options.store["transaction"].bind(options.store);
  const durableRuns = {
    getRun: (runId: string) => options.store.runs.getRun(runId),
    updateRun: (runId: string, input: Parameters<SessionStore["runs"]["updateRun"]>[1]) => options.store.runs.updateRun(runId, input),
    listRuns: (sessionId: string) => options.store.runs.listRuns(sessionId),
    appendEvent: (input: Parameters<SessionStore["conversations"]["appendEvent"]>[0]) => options.store.conversations.appendEvent(input),
    transaction: <T>(work: () => T) => transaction(work),
  };
  const control = new RunControlService({
    durableSessions: {
      getSession: (sessionId) => options.store.sessions.get(sessionId),
      listSessions: (input) => options.store.sessions.list(input),
    },
    durableRuns,
    durableInputs: options.store.conversations,
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
    sessionQueries: { getSession: (sessionId) => options.store.sessions.get(sessionId) },
    conversationTransactions: {
      admitPrompt: (input, config) => options.store.conversationTransactions.admitPrompt(input, config),
      admitPromptWithRun: (input, config) => options.store.conversationTransactions.admitPromptWithRun(input, config),
      replaceTranscriptAndAdmitPrompt: (input) => options.store.conversationTransactions.replaceTranscriptAndAdmitPrompt({ ...input, createRun: input.createRun ?? false }),
      replaceLatestPromptWithAdmission: (input) => options.store.conversationTransactions.replaceLatestPromptWithAdmission({ ...input, createRun: input.createRun ?? false }),
      getInput: (inputId) => options.store.conversations.getInput(inputId),
    },
    runOperations: {
      createRun: (input) => options.store.runs.createRun(input),
      getRun: (runId) => options.store.runs.getRun(runId),
      findRunByInput: (inputId) => options.store.runs.findRunByInput(inputId),
      createReplayRun: (inputId, input) => options.store.conversationTransactions.createReplayRun(inputId, input),
      updateRun: (runId, input) => options.store.runs.updateRun(runId, input),
      appendEvent: (input) => options.store.conversations.appendEvent(input),
      transaction: (work) => transaction(work),
    },
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
    runExecutor: options.runExecutor,
    events: options.events,
    settleGoalRun: options.settleGoalRun,
    execution: {
      prepareRunExecution: (runId) => admission.prepareRunExecution(runId),
      recoverRejectedSteer: (sessionId, input) => admission.recoverRejectedSteer(sessionId, input),
    },
  });
  return { admission, control, engine };
}

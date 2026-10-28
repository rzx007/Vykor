import type { AttachmentLimits } from "@vykor/domain-contracts/attachments";
import type { SessionUserInputItem } from "@vykor/domain-contracts/inputs";
import type { GoalOperations, SessionStore } from "@vykor/services";
import type { AgentPool } from "../../agent/agent-pool.js";
import type { SessionEventPublisher } from "../transcript/session-event-publisher.js";
import { RunAdmissionService, type RunAdmissionRuntimeQueue } from "./run-admission-service.js";
import { RunControlService, type RunControlRuntime } from "./run-control-service.js";
import { SessionRunEngine } from "./session-run-engine.js";
import type { SessionRunExecutor } from "./session-run-executor.js";

export interface SessionRunAssemblyOptions {
  materializePluginAppContexts?(sessionId: string, value: unknown): Promise<{ items: SessionUserInputItem[]; assertCurrent(): void }>;
  children?: { interruptRun(sessionId: string, runId: string, reason?: string): Promise<boolean>; waitRun?(sessionId: string, runId: string): Promise<void> };
  pendingPermissionId?: (sessionId: string) => string | undefined;
  preemptAutoReview?: (sessionId: string) => void;
  store: Pick<SessionStore, "conversations" | "conversationTransactions" | "runs" | "sessions" | "transaction">;
  goals: GoalOperations;
  agentPool: AgentPool;
  runExecutor: Pick<SessionRunExecutor, "execute">;
  events: Pick<SessionEventPublisher, "checkpoint" | "publishSince">;
  attachmentLimits?: AttachmentLimits;
  materializeSteerInput(sessionId: string, items: readonly SessionUserInputItem[]): Promise<string>;
  assertReady(): void;
  settleGoalRun(sessionId: string, runId: string): Promise<void>;
  settleQueuedGoalResume?(sessionId: string, failed: boolean): Promise<void>;
  checkGoalExecution?(goalId: string, objectiveVersion: number): void;
}

/** Admission and Control share the Engine's queue capabilities, with accepted-run policy applied once. */
export function assembleSessionRunServices(options: SessionRunAssemblyOptions): {
  admission: RunAdmissionService;
  control: RunControlService;
  engine: SessionRunEngine;
} {
  let admission!: RunAdmissionService;
  const engine = new SessionRunEngine({
    runExecutor: options.runExecutor,
    events: options.events,
    settleGoalRun: options.settleGoalRun,
    execution: {
      prepareRunExecution: (runId) => admission.prepareRunExecution(runId),
      recoverRejectedSteer: (sessionId, input) => admission.recoverRejectedSteer(sessionId, input),
    },
  });
  const runtime: RunControlRuntime & RunAdmissionRuntimeQueue = {
    ...engine.runtimeBridge,
    hasRuntime: options.agentPool.configured,
    enqueueRun: (run, inputId) => {
      // Admission, replay and recovered steering all pass this accepted-run boundary.
      if (!run.metadata?.goalRunKind || run.metadata.goalRunKind === "user") {
        options.preemptAutoReview?.(run.sessionId);
      }
      return engine.runtimeBridge.enqueueRun(run, inputId);
    },
  };
  const transaction = options.store["transaction"].bind(options.store);
  const durableRuns = {
    getRun: (runId: string) => options.store.runs.getRun(runId),
    updateRun: (runId: string, input: Parameters<SessionStore["runs"]["updateRun"]>[1]) => options.store.runs.updateRun(runId, input),
    listRuns: (sessionId: string) => options.store.runs.listRuns(sessionId),
    listGoalRuns: (goalId: string, objectiveVersion?: number) => options.store.runs.listGoalRuns(goalId, objectiveVersion),
    appendEvent: (input: Parameters<SessionStore["conversations"]["appendEvent"]>[0]) => options.store.conversations.appendEvent(input),
    transaction: <T>(work: () => T) => transaction(work),
  };
  const control = new RunControlService({
    children: options.children,
    durableSessions: {
      getSession: (sessionId) => options.store.sessions.get(sessionId),
      listSessions: (input) => options.store.sessions.list(input),
    },
    durableRuns,
    durableInputs: options.store.conversations,
    runtime,
    events: options.events,
    goals: options.goals,
    admission: { hasPendingAdmission: (sessionId) => admission.hasPendingAdmission(sessionId) },
    materializeSteerInput: options.materializeSteerInput,
  });
  admission = new RunAdmissionService({
    materializePluginAppContexts: options.materializePluginAppContexts,
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
    runtimeQueue: runtime,
    events: options.events,
    attachmentLimits: options.attachmentLimits,
    goals: {
      userWorkSettled: options.settleQueuedGoalResume,
      getCurrentGoal: (sessionId) => options.goals.getCurrentGoal(sessionId),
      getGoal: (goalId) => options.goals.getGoal(goalId),
      startGoalRun: (goalId, revision, runId, continuation) => options.goals.startGoalRun(goalId, revision, runId, continuation),
      checkExecution: options.checkGoalExecution,
      markGoalContinuation: (runId, status) => options.goals.markGoalContinuation(runId, status),
      hasUserWork: (sessionId) => control.hasUserWork(sessionId),
      pendingPermissionId: options.pendingPermissionId,
      waitForApproval: (goalId, objectiveVersion, permissionRequestId) => {
        const goal = options.goals.getGoal(goalId);
        if (goal?.status === "active" && goal.objectiveVersion === objectiveVersion) options.goals.updateGoal(goal.id, {
          expectedRevision: goal.revision, status: "waiting_user", stopReason: null, reason: "目标需要批准后才能继续",
          wait: { kind: "approval", permissionRequestId },
        });
      },
      cancelGoalRuns: (sessionId, goalId, reason, queuedOnly) => control.cancelGoalRuns(sessionId, goalId, reason, queuedOnly),
    },
    materializer: { materializeSteerInput: options.materializeSteerInput },
    assertReady: options.assertReady,
  });
  return { admission, control, engine };
}

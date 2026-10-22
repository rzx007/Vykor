import type { PromptAttachment, SessionUserInputItem } from "../inputs/items.js";
export type GoalStatus = "active" | "waiting_user" | "blocked" | "paused" | "completed" | "cancelled";
export type GoalUserActor = { kind: "local_user" } | { kind: "authenticated_user"; id: string };
export interface GoalVersion {
  goalId: string;
  objectiveVersion: number;
  previousVersion?: number;
  objective: string;
  requestId: string;
  actor: GoalUserActor;
  createdAt: number;
}

export type GoalAction = "pause" | "resume" | "cancel" | "budget" | "cancel_resume";

export interface GoalUsage {
  knownTokens: number;
  incomplete: boolean;
  unknownAttempts: number;
  partialAttempts: number;
  inFlightAttempts: number;
  runTimeMs: number;
  seq: number;
  updatedAt: number;
}

export interface GoalModelAttemptKey {
  runId: string;
  generationId: string;
  attempt: number;
}

export interface GoalStopReason {
  code: "user_paused" | "user_cancelled" | "updating_objective" | "auto_turn_limit"
    | "run_error" | "wait_invalid" | "wait_timeout"
    | "external_failed" | "no_progress" | "startup_recovery" | "token_budget"
    | "usage_unknown" | "provider_limit";
  at: number;
  runId?: string;
  detail?: string;
}

export interface GoalExternalWait {
  kind: "external";
  targetRunId: string;
  ownerRunId: string;
  goalId: string;
  objectiveVersion: number;
  deadlineAt: number;
  observedStatus?: "pending" | "running" | "completed" | "failed" | "interrupted";
}

export type GoalWait =
  | {
      kind: "user";
      questionId: string;
      question: string;
      objectiveVersion: number;
      replyInputId?: string;
      /** Accepted answer restored after a queued Run could not be dispatched. */
      response?: string;
    }
  | { kind: "approval"; permissionRequestId: string }
  | GoalExternalWait;

export interface SessionGoal {
  id: string;
  sessionId: string;
  objective: string;
  objectiveVersion: number;
  pluginId?: string;
  revision: number;
  status: GoalStatus;
  maxAutoTurns: number;
  tokenBudget?: number;
  usage: GoalUsage;
  autoTurnsUsed: number;
  currentRunId?: string;
  /** A single accepted resume waiting for user work to finish. */
  queuedResume?: { requestId: string };
  reason?: string;
  stopReason?: GoalStopReason;
  wait?: GoalWait;
  createdAt: number;
  updatedAt: number;
}

export interface CreateSessionGoalInput {
  requestId: string;
  objective: string;
  maxAutoTurns?: number;
  tokenBudget?: number;
  items?: SessionUserInputItem[];
  attachments?: PromptAttachment[];
}

export interface UpdateSessionGoalInput {
  requestId: string;
  expectedRevision: number;
  objective: string;
  items?: SessionUserInputItem[];
  attachments?: PromptAttachment[];
}

export interface GoalActionInput {
  requestId: string;
  expectedRevision: number;
  action: GoalAction;
  tokenBudget?: number | null;
  additionalAutoTurns?: number;
  questionId?: string;
  response?: string;
  objectiveVersion?: number;
}

export type GoalUpdateInput =
  | { status: "completed" | "blocked" | "paused"; reason: string }
  | { question: string }
  | { wait: { targetRunId: string; deadlineAt: number } };


export const MAX_GOAL_AUTO_TURNS = 1_000;
export const MAX_GOAL_OBJECTIVE_CHARS = 32_000;

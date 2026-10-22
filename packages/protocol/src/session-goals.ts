import type { AdmitPromptAttachmentInput } from "./session.js";
import type { SessionUserInputItem } from "./session-input-items.js";
import { parsePromptAttachments, parseSessionInputItems, ProtocolValidationError } from "./requests.js";

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
  attachments?: AdmitPromptAttachmentInput[];
}

export interface UpdateSessionGoalInput {
  requestId: string;
  expectedRevision: number;
  objective: string;
  items?: SessionUserInputItem[];
  attachments?: AdmitPromptAttachmentInput[];
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

/** Zero means no automatic-turn limit. */
export const DEFAULT_GOAL_AUTO_TURNS = 0;
export const MAX_GOAL_AUTO_TURNS = 1_000;
export const MAX_GOAL_OBJECTIVE_CHARS = 32_000;

export function parseCreateSessionGoalInput(value: unknown): CreateSessionGoalInput {
  const record = goalRecord(value);
  assertGoalFields(record, ["requestId", "objective", "maxAutoTurns", "tokenBudget", "items", "attachments"]);
  return {
    requestId: requiredGoalString(record.requestId, "requestId", 128),
    objective: requiredGoalString(record.objective, "objective", MAX_GOAL_OBJECTIVE_CHARS),
    ...(record.tokenBudget === undefined ? {} : { tokenBudget: goalPositiveTimestamp(record.tokenBudget, "tokenBudget") }),
    ...(record.maxAutoTurns === undefined
      ? {}
      : {
          maxAutoTurns: goalPositiveInteger(record.maxAutoTurns, "maxAutoTurns", true),
        }),
    ...parseGoalContent(record),
  };
}

export function parseUpdateSessionGoalInput(value: unknown): UpdateSessionGoalInput {
  const record = goalRecord(value);
  assertGoalFields(record, ["requestId", "expectedRevision", "objective", "items", "attachments"]);
  return {
    requestId: requiredGoalString(record.requestId, "requestId", 128),
    expectedRevision: goalNonNegativeInteger(record.expectedRevision, "expectedRevision"),
    objective: requiredGoalString(record.objective, "objective", MAX_GOAL_OBJECTIVE_CHARS),
    ...parseGoalContent(record),
  };
}

export function parseGoalActionInput(value: unknown): GoalActionInput {
  const record = goalRecord(value);
  if (record.action !== "pause" && record.action !== "resume" && record.action !== "cancel" && record.action !== "budget" && record.action !== "cancel_resume") {
    throw new ProtocolValidationError("invalid_goal_action", "action");
  }
  const common = {
    requestId: requiredGoalString(record.requestId, "requestId", 128),
    expectedRevision: goalNonNegativeInteger(record.expectedRevision, "expectedRevision"),
  };
  if (record.action === "budget") {
    assertGoalFields(record, ["requestId", "expectedRevision", "action", "tokenBudget"]);
    return { ...common, action: "budget", tokenBudget: record.tokenBudget === null ? null : goalPositiveTimestamp(record.tokenBudget, "tokenBudget") };
  }
  assertGoalFields(record, record.action === "resume"
    ? ["requestId", "expectedRevision", "action", "additionalAutoTurns", "questionId", "response", "objectiveVersion"]
    : ["requestId", "expectedRevision", "action"]);
  if (record.questionId !== undefined) goalPositiveTimestamp(record.objectiveVersion, "objectiveVersion");
  else if (record.objectiveVersion !== undefined) throw new ProtocolValidationError("goal_version_requires_answer", "objectiveVersion");
  return {
    ...common, action: record.action,
    ...(record.questionId === undefined ? {} : { questionId: requiredGoalString(record.questionId, "questionId", 256), objectiveVersion: goalPositiveTimestamp(record.objectiveVersion, "objectiveVersion") }),
    ...(record.response === undefined ? {} : { response: requiredGoalString(record.response, "response", MAX_GOAL_OBJECTIVE_CHARS) }),
    ...(record.additionalAutoTurns === undefined ? {} : { additionalAutoTurns: goalPositiveInteger(record.additionalAutoTurns, "additionalAutoTurns") }),
  };
}

/** The host supplies all Goal and submitting Run identity. */
export function parseGoalUpdateInput(value: unknown): GoalUpdateInput {
  const record = goalRecord(value);
  if (Object.hasOwn(record, "status")) {
    assertGoalFields(record, ["status", "reason"]);
    if (record.status !== "completed" && record.status !== "blocked" && record.status !== "paused") throw new ProtocolValidationError("invalid_goal_status", "status");
    return { status: record.status, reason: requiredGoalString(record.reason, "reason", 4000) };
  }
  if (Object.hasOwn(record, "question")) {
    assertGoalFields(record, ["question"]);
    return { question: requiredGoalString(record.question, "question", 4000) };
  }
  assertGoalFields(record, ["wait"]);
  const wait = goalRecord(record.wait);
  assertGoalFields(wait, ["targetRunId", "deadlineAt"]);
  return { wait: { targetRunId: requiredGoalString(wait.targetRunId, "targetRunId", 256), deadlineAt: goalPositiveTimestamp(wait.deadlineAt, "deadlineAt") } };
}

function assertGoalFields(record: Record<string, unknown>, fields: string[]): void {
  for (const field of Object.keys(record)) if (!fields.includes(field)) throw new ProtocolValidationError(`invalid_goal_${field}`, field);
}

function goalRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ProtocolValidationError("invalid_goal_input", "goal");
  return value as Record<string, unknown>;
}

function requiredGoalString(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value)) throw new ProtocolValidationError(`invalid_goal_${field}`, field);
  const normalized = value.trim();
  if (normalized.length > max) throw new ProtocolValidationError(`goal_${field}_limit_exceeded`, field);
  return normalized;
}

function goalNonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new ProtocolValidationError(`invalid_goal_${field}`, field);
  return value as number;
}

function goalPositiveInteger(value: unknown, field: string, allowUnlimited = false): number {
  const integer = goalNonNegativeInteger(value, field);
  if (integer < (allowUnlimited ? 0 : 1) || integer > MAX_GOAL_AUTO_TURNS) throw new ProtocolValidationError(`invalid_goal_${field}`, field);
  return integer;
}
function parseGoalContent(record: Record<string, unknown>): Pick<CreateSessionGoalInput, "items" | "attachments"> {
  return {
    ...(record.items === undefined ? {} : { items: parseSessionInputItems(record.items) }),
    ...(record.attachments === undefined ? {} : { attachments: parsePromptAttachments(record.attachments) }),
  };
}

function goalPositiveTimestamp(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new ProtocolValidationError(`invalid_goal_${field}`, field);
  return value as number;
}

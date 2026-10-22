import type { CreateSessionGoalInput, UpdateSessionGoalInput, GoalActionInput, GoalUpdateInput } from "./records.js";
import { MAX_GOAL_AUTO_TURNS, MAX_GOAL_OBJECTIVE_CHARS } from "./records.js";
import { parsePromptAttachments, parseSessionInputItems } from "../inputs/validation.js";
import { DomainValidationError } from "../validation-error.js";
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
    throw new DomainValidationError("invalid_goal_action", "action");
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
  else if (record.objectiveVersion !== undefined) throw new DomainValidationError("goal_version_requires_answer", "objectiveVersion");
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
    if (record.status !== "completed" && record.status !== "blocked" && record.status !== "paused") throw new DomainValidationError("invalid_goal_status", "status");
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
  for (const field of Object.keys(record)) if (!fields.includes(field)) throw new DomainValidationError(`invalid_goal_${field}`, field);
}

function goalRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new DomainValidationError("invalid_goal_input", "goal");
  return value as Record<string, unknown>;
}

function requiredGoalString(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value)) throw new DomainValidationError(`invalid_goal_${field}`, field);
  const normalized = value.trim();
  if (normalized.length > max) throw new DomainValidationError(`goal_${field}_limit_exceeded`, field);
  return normalized;
}

function goalNonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new DomainValidationError(`invalid_goal_${field}`, field);
  return value as number;
}

function goalPositiveInteger(value: unknown, field: string, allowUnlimited = false): number {
  const integer = goalNonNegativeInteger(value, field);
  if (integer < (allowUnlimited ? 0 : 1) || integer > MAX_GOAL_AUTO_TURNS) throw new DomainValidationError(`invalid_goal_${field}`, field);
  return integer;
}
function parseGoalContent(record: Record<string, unknown>): Pick<CreateSessionGoalInput, "items" | "attachments"> {
  return {
    ...(record.items === undefined ? {} : { items: parseSessionInputItems(record.items) }),
    ...(record.attachments === undefined ? {} : { attachments: parsePromptAttachments(record.attachments) }),
  };
}

function goalPositiveTimestamp(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new DomainValidationError(`invalid_goal_${field}`, field);
  return value as number;
}

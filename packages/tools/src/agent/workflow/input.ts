import type { WorkflowBudgetPolicyPreset, WorkflowFailurePolicy, WorkflowMode, WorkflowRunSummary, WorkflowSpec, WorkflowTask, WorkflowTemplateName } from "@vykor/coordinator";

const WORKFLOW_MODES = new Set<WorkflowMode>(["parallel", "sequential", "pipeline"]);
const FAILURE_POLICIES = new Set<WorkflowFailurePolicy>(["skip-dependents", "fail-fast", "continue"]);
const WORKFLOW_ACTIONS = new Set(["run", "resume", "timeline", "history", "template", "reconcile", "validate"]);
const BUDGET_POLICY_PRESETS = new Set<WorkflowBudgetPolicyPreset>(["cheap-review", "safe-write", "fast-parallel"]);

export function parseWorkflowSpec(input: Record<string, unknown>): WorkflowSpec | string {
  const mode = input.mode;
  if (!isWorkflowMode(mode)) {
    return "mode must be one of: parallel, sequential, pipeline";
  }
  if (!Array.isArray(input.tasks) || input.tasks.length === 0) {
    return "tasks must be a non-empty array";
  }

  const failurePolicy = input.failurePolicy;
  if (failurePolicy !== undefined && !isFailurePolicy(failurePolicy)) {
    return "failurePolicy must be one of: skip-dependents, fail-fast, continue";
  }

  const maxConcurrency = input.maxConcurrency;
  if (maxConcurrency !== undefined && typeof maxConcurrency !== "number") {
    return "maxConcurrency must be a number";
  }
  const defaultTaskTimeoutMs = secondsToOptionalMs(input.defaultTaskTimeoutSeconds);
  if (defaultTaskTimeoutMs === "invalid") {
    return "defaultTaskTimeoutSeconds must be a positive number";
  }
  const budgetPolicyOrError = parseBudgetPolicy(input.budgetPolicy);
  if (typeof budgetPolicyOrError === "string") return budgetPolicyOrError;
  const budgetPolicyPreset = input.budgetPreset;
  if (budgetPolicyPreset !== undefined && !isBudgetPolicyPreset(budgetPolicyPreset)) {
    return "budgetPreset must be one of: cheap-review, safe-write, fast-parallel";
  }

  const tasks: WorkflowTask[] = [];
  for (const [index, rawTask] of input.tasks.entries()) {
    if (!isRecord(rawTask)) {
      return `tasks[${index}] must be an object`;
    }
    const taskOrError = parseWorkflowTask(rawTask, index);
    if (typeof taskOrError === "string") return taskOrError;
    tasks.push(taskOrError);
  }

  return {
    mode,
    tasks,
    ...(maxConcurrency !== undefined ? { maxConcurrency } : {}),
    ...(defaultTaskTimeoutMs !== undefined ? { defaultTaskTimeoutMs } : {}),
    ...(budgetPolicyPreset !== undefined ? { budgetPolicyPreset } : {}),
    ...(budgetPolicyOrError !== undefined ? { budgetPolicy: budgetPolicyOrError } : {}),
    ...(failurePolicy !== undefined ? { failurePolicy } : {}),
  };
}

export function parseAction(value: unknown): "run" | "resume" | "timeline" | "history" | "template" | "reconcile" | "validate" | undefined {
  if (value === undefined) return "run";
  return typeof value === "string" && WORKFLOW_ACTIONS.has(value)
    ? value as "run" | "resume" | "timeline" | "history" | "template" | "reconcile" | "validate"
    : undefined;
}

function parseWorkflowTask(input: Record<string, unknown>, index: number): WorkflowTask | string {
  const id = input.id;
  if (typeof id !== "string" || id.trim() === "") {
    return `tasks[${index}].id must be a non-empty string`;
  }
  const retryOrError = parseRetry(input.retry, index);
  if (typeof retryOrError === "string") return retryOrError;
  const timeoutMs = secondsToOptionalMs(input.timeoutSeconds);
  if (timeoutMs === "invalid") {
    return `tasks[${index}].timeoutSeconds must be a positive number`;
  }

  return {
    id,
    description: asOptionalString(input.description),
    prompt: asOptionalString(input.prompt),
    subagentType: asOptionalString(input.subagentType),
    model: asOptionalString(input.model),
    team: asOptionalString(input.team),
    permissionMode: parsePermissionMode(input.permissionMode),
    dependsOn: parseStringArray(input.dependsOn),
    retry: retryOrError,
    timeoutMs,
    readOnly: typeof input.readOnly === "boolean" ? input.readOnly : undefined,
    writeScope: parseStringArray(input.writeScope),
    isolate: typeof input.isolate === "boolean" ? input.isolate : undefined,
  };
}

function parseRetry(input: unknown, taskIndex: number): WorkflowTask["retry"] | string {
  if (input === undefined) return undefined;
  if (!isRecord(input)) return `tasks[${taskIndex}].retry must be an object`;
  const retryOn = parseStringArray(input.retryOn);
  const invalidRetryOn = retryOn?.find((status) => status !== "failed" && status !== "killed");
  if (invalidRetryOn) return `tasks[${taskIndex}].retry.retryOn contains invalid status '${invalidRetryOn}'`;
  const maxAttempts = input.maxAttempts;
  if (maxAttempts !== undefined && typeof maxAttempts !== "number") {
    return `tasks[${taskIndex}].retry.maxAttempts must be a number`;
  }
  return {
    ...(maxAttempts !== undefined ? { maxAttempts } : {}),
    ...(retryOn !== undefined ? { retryOn: retryOn as Array<"failed" | "killed"> } : {}),
  };
}

function parseBudgetPolicy(input: unknown): WorkflowSpec["budgetPolicy"] | string {
  if (input === undefined) return undefined;
  if (!isRecord(input)) return "budgetPolicy must be an object";
  const maxTokensUsed = input.maxTokensUsed;
  const maxTimeUsedMs = secondsToOptionalMs(input.maxTimeUsedSeconds);
  const softMaxTokensUsed = input.softMaxTokensUsed;
  const softMaxTimeUsedMs = secondsToOptionalMs(input.softMaxTimeUsedSeconds);
  const onSoftLimit = input.onSoftLimit;
  const conserveOrError = parseConservePolicy(input.conserve);
  if (maxTokensUsed !== undefined && (typeof maxTokensUsed !== "number" || !Number.isFinite(maxTokensUsed) || maxTokensUsed <= 0)) {
    return "budgetPolicy.maxTokensUsed must be a positive number";
  }
  if (maxTimeUsedMs === "invalid") {
    return "budgetPolicy.maxTimeUsedSeconds must be a positive number";
  }
  if (softMaxTokensUsed !== undefined && (typeof softMaxTokensUsed !== "number" || !Number.isFinite(softMaxTokensUsed) || softMaxTokensUsed <= 0)) {
    return "budgetPolicy.softMaxTokensUsed must be a positive number";
  }
  if (softMaxTimeUsedMs === "invalid") {
    return "budgetPolicy.softMaxTimeUsedSeconds must be a positive number";
  }
  if (
    onSoftLimit !== undefined &&
    onSoftLimit !== "continue" &&
    onSoftLimit !== "serialize" &&
    onSoftLimit !== "conserve" &&
    onSoftLimit !== "serialize-and-conserve"
  ) {
    return "budgetPolicy.onSoftLimit must be one of: continue, serialize, conserve, serialize-and-conserve";
  }
  if (typeof conserveOrError === "string") return conserveOrError;
  return {
    ...(maxTokensUsed !== undefined ? { maxTokensUsed } : {}),
    ...(maxTimeUsedMs !== undefined ? { maxTimeUsedMs } : {}),
    ...(softMaxTokensUsed !== undefined ? { softMaxTokensUsed } : {}),
    ...(softMaxTimeUsedMs !== undefined ? { softMaxTimeUsedMs } : {}),
    ...(onSoftLimit !== undefined ? { onSoftLimit } : {}),
    ...(conserveOrError !== undefined ? { conserve: conserveOrError } : {}),
  };
}

function parseConservePolicy(input: unknown): NonNullable<WorkflowSpec["budgetPolicy"]>["conserve"] | string {
  if (input === undefined) return undefined;
  if (!isRecord(input)) return "budgetPolicy.conserve must be an object";
  const promptHint = asOptionalString(input.promptHint);
  const permissionMode = input.permissionMode;
  const maxTurns = input.maxTurns;
  if (permissionMode !== undefined && permissionMode !== "default" && permissionMode !== "plan") {
    return "budgetPolicy.conserve.permissionMode must be one of: default, plan";
  }
  if (maxTurns !== undefined && (typeof maxTurns !== "number" || !Number.isInteger(maxTurns) || maxTurns < 1)) {
    return "budgetPolicy.conserve.maxTurns must be a positive integer";
  }
  return {
    ...(promptHint !== undefined ? { promptHint } : {}),
    ...(permissionMode !== undefined ? { permissionMode } : {}),
    ...(maxTurns !== undefined ? { maxTurns } : {}),
  };
}

function isWorkflowMode(value: unknown): value is WorkflowMode {
  return typeof value === "string" && WORKFLOW_MODES.has(value as WorkflowMode);
}

export function isFailurePolicy(value: unknown): value is WorkflowFailurePolicy {
  return typeof value === "string" && FAILURE_POLICIES.has(value as WorkflowFailurePolicy);
}

export function isBudgetPolicyPreset(value: unknown): value is WorkflowBudgetPolicyPreset {
  return typeof value === "string" && BUDGET_POLICY_PRESETS.has(value as WorkflowBudgetPolicyPreset);
}

export function isWorkflowTemplateName(value: unknown): value is WorkflowTemplateName {
  return (
    value === "research-implement-verify" ||
    value === "parallel-review" ||
    value === "safe-write"
  );
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseStringArray(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string");
}

export function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function parsePermissionMode(value: unknown): "default" | "plan" | "full_auto" | undefined {
  if (value === "default" || value === "plan" || value === "full_auto") return value;
  return undefined;
}

export function secondsToOptionalMs(value: unknown): number | undefined | "invalid" {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "invalid";
  return Math.floor(value * 1000);
}

function parsePositiveInteger(value: unknown): number | undefined | "invalid" {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) return "invalid";
  return value;
}

export function parseRunListFilters(input: Record<string, unknown>): RunListFilters | string {
  const statuses = parseRunStatuses(input.runStatuses);
  if (typeof statuses === "string") return statuses;
  const limit = parsePositiveInteger(input.limit);
  if (limit === "invalid") return "limit must be a positive integer";
  const createdAfter = parseTimestampFilter(input.createdAfter, "createdAfter");
  if (typeof createdAfter === "string") return createdAfter;
  const createdBefore = parseTimestampFilter(input.createdBefore, "createdBefore");
  if (typeof createdBefore === "string") return createdBefore;
  const updatedAfter = parseTimestampFilter(input.updatedAfter, "updatedAfter");
  if (typeof updatedAfter === "string") return updatedAfter;
  const updatedBefore = parseTimestampFilter(input.updatedBefore, "updatedBefore");
  if (typeof updatedBefore === "string") return updatedBefore;
  const budgetPreset = input.budgetPreset;
  if (budgetPreset !== undefined && !isBudgetPolicyPreset(budgetPreset)) {
    return "budgetPreset must be one of: cheap-review, safe-write, fast-parallel";
  }
  return {
    statuses,
    limit,
    runIdPrefix: asOptionalString(input.runIdPrefix),
    createdAfter,
    createdBefore,
    updatedAfter,
    updatedBefore,
    needsReconciliation: typeof input.needsReconciliation === "boolean" ? input.needsReconciliation : undefined,
    budgetPreset,
  };
}

function parseRunStatuses(value: unknown): Array<WorkflowRunSummary["status"]> | string | undefined {
  const statuses = parseStringArray(value);
  if (statuses === undefined) return undefined;
  const invalid = statuses.find((status) => status !== "running" && status !== "completed" && status !== "failed");
  return invalid ? "runStatuses must contain only: running, completed, failed" : statuses as Array<WorkflowRunSummary["status"]>;
}

function parseTimestampFilter(value: unknown, field: string): number | string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return `${field} must be an epoch millisecond number or ISO date string`;
}

export interface TimelineFilters {
  taskIds?: string[];
  eventTypes?: string[];
  statuses?: string[];
}

export interface RunListFilters {
  statuses?: Array<WorkflowRunSummary["status"]>;
  limit?: number;
  runIdPrefix?: string;
  createdAfter?: number;
  createdBefore?: number;
  updatedAfter?: number;
  updatedBefore?: number;
  needsReconciliation?: boolean;
  budgetPreset?: WorkflowBudgetPolicyPreset;
}

export function parseTimelineFilters(input: Record<string, unknown>): TimelineFilters {
  return {
    taskIds: parseStringArray(input.taskIds),
    eventTypes: parseStringArray(input.eventTypes),
    statuses: parseStringArray(input.statuses),
  };
}

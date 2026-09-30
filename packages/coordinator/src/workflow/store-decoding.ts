import type { WorkflowRunEvent, WorkflowRunSnapshot } from "./model.js";

export function decodeWorkflowRunSnapshot(text: string): WorkflowRunSnapshot {
  const value = JSON.parse(text) as unknown;
  if (!isWorkflowRunSnapshot(value)) {
    throw new Error("Invalid workflow run snapshot");
  }
  return value;
}

export function decodeWorkflowRunEvent(text: string): WorkflowRunEvent {
  const value = JSON.parse(text) as unknown;
  if (!isWorkflowRunEvent(value)) throw new Error("Invalid workflow run event");
  return value;
}

function isWorkflowRunSnapshot(value: unknown): value is WorkflowRunSnapshot {
  if (!isRecord(value)) return false;
  const candidate = value as unknown as WorkflowRunSnapshot;
  return (
    candidate.version === 1 &&
    typeof candidate.runId === "string" &&
    (candidate.status === "running" || candidate.status === "completed" || candidate.status === "failed") &&
    (candidate.termination === undefined || candidate.termination === "cancelled") &&
    typeof candidate.summary === "string" &&
    isWorkflowSpec(candidate.spec) &&
    isWorkflowPlan(candidate.plan) &&
    isRecordOf(candidate.results, isWorkflowTaskResult) &&
    Array.isArray(candidate.orderedResults) && candidate.orderedResults.every(isWorkflowTaskResult) &&
    isStringArray(candidate.pendingTaskIds) &&
    isStringArray(candidate.blockedTaskIds) &&
    isRecordOf(candidate.blockedTasks, isWorkflowBlockedTask) &&
    isStringArray(candidate.runningTaskIds) &&
    isRecordOf(candidate.runningTasks, isWorkflowRunningTask) &&
    isRecord(candidate.budget) &&
    isFiniteNumber(candidate.createdAt) &&
    isFiniteNumber(candidate.updatedAt)
  );
}

function isWorkflowRunEvent(value: unknown): value is WorkflowRunEvent {
  if (!isRecord(value)) return false;
  const candidate = value as unknown as WorkflowRunEvent;
  if (!(
    candidate.version === 1 &&
    isNonEmptyString(candidate.runId) &&
    WORKFLOW_EVENT_TYPES.has(candidate.type) &&
    isFiniteNumber(candidate.timestamp)
  )) return false;
  if (candidate.summary !== undefined && typeof candidate.summary !== "string") return false;
  if (candidate.taskId !== undefined && !isNonEmptyString(candidate.taskId)) return false;
  if (candidate.attempt !== undefined &&
      (!Number.isSafeInteger(candidate.attempt) || Number(candidate.attempt) < 1)) return false;
  if (candidate.runningTask !== undefined && !isWorkflowRunningTask(candidate.runningTask)) return false;
  if (candidate.blockedTask !== undefined && !isWorkflowBlockedTask(candidate.blockedTask)) return false;
  if (candidate.result !== undefined && !isWorkflowTaskResult(candidate.result)) return false;
  return true;
}

const WORKFLOW_EVENT_TYPES = new Set<string>([
  "workflow_started",
  "task_started",
  "task_progress",
  "task_blocked",
  "workflow_budget_conserving",
  "workflow_budget_exceeded",
  "task_finished",
  "workflow_cancelled",
  "workflow_finished",
]);

function isWorkflowSpec(value: unknown): boolean {
  return isRecord(value) && isWorkflowMode(value.mode) &&
    Array.isArray(value.tasks) && value.tasks.every(isWorkflowTask);
}

function isWorkflowPlan(value: unknown): boolean {
  if (!isRecord(value) || !isWorkflowMode(value.mode)) return false;
  if (!Array.isArray(value.tasks) || !value.tasks.every(isWorkflowTask)) return false;
  if (!(value.maxConcurrency === "unbounded" || isNonNegativeNumber(value.maxConcurrency))) return false;
  return isStringArray(value.executionOrder) &&
    isRecordOf(value.dependencyMap, isStringArray) &&
    isRecordOf(value.dependentsMap, isStringArray);
}

function isWorkflowTask(value: unknown): boolean {
  return isRecord(value) && isNonEmptyString(value.id) &&
    (value.dependsOn === undefined || isStringArray(value.dependsOn));
}

function isWorkflowTaskResult(value: unknown): boolean {
  return isRecord(value) && isNonEmptyString(value.taskId) &&
    ["completed", "failed", "killed", "skipped"].includes(String(value.status)) &&
    typeof value.summary === "string" && Number.isSafeInteger(value.attempts) &&
    Number(value.attempts) >= 0 && isStringArray(value.dependencies) &&
    isFiniteNumber(value.startedAt) && isFiniteNumber(value.finishedAt);
}

function isWorkflowRunningTask(value: unknown): boolean {
  return isRecord(value) && isNonEmptyString(value.taskId) &&
    Number.isSafeInteger(value.attempt) && Number(value.attempt) >= 1 &&
    isStringArray(value.dependencies) && isFiniteNumber(value.startedAt) &&
    typeof value.summary === "string";
}

function isWorkflowBlockedTask(value: unknown): boolean {
  return isRecord(value) && isNonEmptyString(value.taskId) &&
    typeof value.reason === "string" && isStringArray(value.waitingForTaskIds);
}

function isWorkflowMode(value: unknown): boolean {
  return value === "parallel" || value === "sequential" || value === "pipeline";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRecordOf(
  value: unknown,
  predicate: (item: unknown) => boolean,
): boolean {
  return isRecord(value) && Object.values(value).every(predicate);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonNegativeNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
}

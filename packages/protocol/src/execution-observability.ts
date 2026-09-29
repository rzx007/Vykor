export const EXECUTION_KINDS = [
  "root_agent_run",
  "child_agent_run",
  "workflow_run",
  "workflow_task",
] as const;

export const EXECUTION_OUTCOMES = [
  "completed",
  "failed",
  "timed_out",
  "cancelled",
  "blocked",
  "skipped",
  "running",
  "pending",
  "unknown",
] as const;

export const EXECUTION_FAILURE_KINDS = [
  "model_error",
  "tool_error",
  "timeout",
  "permission_denied",
  "budget_exceeded",
  "dependency_failed",
  "cancelled_by_user",
  "cancelled_by_parent",
  "recovery_failed",
  "conflict",
  "unknown",
] as const;

export type ExecutionKind = (typeof EXECUTION_KINDS)[number];
export type ExecutionOutcome = (typeof EXECUTION_OUTCOMES)[number];
export type ExecutionFailureKind = (typeof EXECUTION_FAILURE_KINDS)[number];
export type ExecutionUsageCompleteness = "complete" | "partial" | "unknown";

export type ExecutionObservationWarningCode =
  | "invalid_workflow_snapshot"
  | "invalid_workflow_event"
  | "missing_parent_execution"
  | "missing_backing_execution"
  | "partial_usage";

export interface ExecutionObservationWarning {
  code: ExecutionObservationWarningCode;
  sourceId: string;
}

export interface ExecutionObservation {
  schemaVersion: 1;
  executionKind: ExecutionKind;
  executionId: string;
  parentExecutionId?: string;
  backingExecutionIds?: string[];
  traceId?: string;
  sessionId?: string;
  runId?: string;
  childId?: string;
  childSessionId?: string;
  workflowRunId?: string;
  workflowTaskId?: string;
  model?: string;
  provider?: string;
  workflowMode?: "sequential" | "parallel" | "pipeline";
  configuredConcurrency?: number;
  attemptCount?: number;
  createdAt?: number;
  startedAt?: number;
  finishedAt?: number;
  durationMs?: number;
  outcome: ExecutionOutcome;
  failureKind?: ExecutionFailureKind;
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
    completeness: ExecutionUsageCompleteness;
  };
  source: { kind: "session_run" | "workflow_snapshot"; id: string };
  completeness: "complete" | "partial";
}

export interface ExecutionObservationFilter {
  from?: number;
  to?: number;
  executionKinds?: ExecutionKind[];
  outcomes?: ExecutionOutcome[];
  failureKinds?: ExecutionFailureKind[];
  sessionId?: string;
  runId?: string;
  childId?: string;
  workflowRunId?: string;
  workflowTaskId?: string;
  model?: string;
  provider?: string;
}

export interface ExecutionKindSummary {
  total: number;
  technicalTerminal: number;
  completed: number;
  failed: number;
  timedOut: number;
  cancelled: number;
  blocked: number;
  skipped: number;
  unknown: number;
  completionRate?: number;
  failureRate?: number;
  duration: { count: number; sumMs: number; minMs?: number; maxMs?: number };
  usage: {
    inputTokens: number;
    outputTokens: number;
    completeRecords: number;
    partialRecords: number;
    unknownRecords: number;
  };
  failures: Partial<Record<ExecutionFailureKind, number>>;
}

export interface ExecutionObservationExport {
  schemaVersion: 1;
  generatedAt: number;
  filters: ExecutionObservationFilter;
  summary: Partial<Record<ExecutionKind, ExecutionKindSummary>>;
  records: ExecutionObservation[];
  warnings: ExecutionObservationWarning[];
}

const EXECUTION_KIND_SET = new Set<string>(EXECUTION_KINDS);
const EXECUTION_OUTCOME_SET = new Set<string>(EXECUTION_OUTCOMES);
const EXECUTION_FAILURE_KIND_SET = new Set<string>(EXECUTION_FAILURE_KINDS);

const MAX_FILTER_ITEMS = 16;
const MAX_TEXT_LENGTH = 256;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

/**
 * 把 HTTP/CLI 的原始查询参数解析成稳定过滤条件。所有校验失败统一抛出以
 * `invalid_` 开头的固定错误码，调用方据此映射为 400，不泄漏原始输入。
 */
export function parseExecutionObservationFilter(
  input: Record<string, unknown>,
): ExecutionObservationFilter {
  const executionKinds = parseEnumList(
    input.kind,
    EXECUTION_KIND_SET,
    "invalid_execution_kind",
  ) as ExecutionKind[] | undefined;
  const outcomes = parseEnumList(
    input.outcome,
    EXECUTION_OUTCOME_SET,
    "invalid_execution_outcome",
  ) as ExecutionOutcome[] | undefined;
  const failureKinds = parseEnumList(
    input.failureKind ?? input.failureKinds,
    EXECUTION_FAILURE_KIND_SET,
    "invalid_execution_failure_kind",
  ) as ExecutionFailureKind[] | undefined;

  const from = parseTimestamp(input.from, "invalid_observation_from");
  const to = parseTimestamp(input.to, "invalid_observation_to");
  if (from !== undefined && to !== undefined && from > to) {
    throw new Error("invalid_observation_range");
  }

  const sessionId = parseText(input.sessionId, "invalid_observation_session_id");
  const runId = parseText(input.runId, "invalid_observation_run_id");
  const childId = parseText(input.childId, "invalid_observation_child_id");
  const workflowRunId = parseText(
    input.workflowRunId,
    "invalid_observation_workflow_run_id",
  );
  const workflowTaskId = parseText(
    input.workflowTaskId,
    "invalid_observation_workflow_task_id",
  );
  const model = parseText(input.model, "invalid_observation_model");
  const provider = parseText(input.provider, "invalid_observation_provider");

  return {
    ...(from !== undefined ? { from } : {}),
    ...(to !== undefined ? { to } : {}),
    ...(executionKinds ? { executionKinds } : {}),
    ...(outcomes ? { outcomes } : {}),
    ...(failureKinds ? { failureKinds } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(runId ? { runId } : {}),
    ...(childId ? { childId } : {}),
    ...(workflowRunId ? { workflowRunId } : {}),
    ...(workflowTaskId ? { workflowTaskId } : {}),
    ...(model ? { model } : {}),
    ...(provider ? { provider } : {}),
  };
}

function parseEnumList(
  raw: unknown,
  allowed: ReadonlySet<string>,
  code: string,
): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") throw new Error(code);
  const values: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(",")) {
    const value = part.trim();
    if (value === "") continue;
    if (!allowed.has(value)) throw new Error(code);
    if (seen.has(value)) continue;
    seen.add(value);
    values.push(value);
    if (values.length > MAX_FILTER_ITEMS) throw new Error(code);
  }
  return values.length > 0 ? values : undefined;
}

function parseTimestamp(raw: unknown, code: string): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "string" && raw.trim() === "") return undefined;
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(code);
  return value;
}

function parseText(raw: unknown, code: string): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") throw new Error(code);
  if (raw.length < 1 || raw.length > MAX_TEXT_LENGTH) throw new Error(code);
  if (CONTROL_CHARACTER_PATTERN.test(raw)) throw new Error(code);
  return raw;
}

/** Application query results. HTTP maps these to the public wire DTO. */
import type { AutoReviewStatus, AutoReviewRiskLevel, AutoReviewVerdict } from "@vykor/domain-contracts/approvals";
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
    totalTokens?: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
    completeness: ExecutionUsageCompleteness;
  };
  source: { kind: "session_run" | "workflow_snapshot"; id: string };
  completeness: "complete" | "partial";
  /** Bounded automatic review outcome projected from the parent Run metadata. */
  review?: {
    policyVersion: "risk-v1";
    riskLevel: AutoReviewRiskLevel;
    status: AutoReviewStatus;
    verdict?: AutoReviewVerdict;
    findingCount?: number;
  };
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
  reviewStatuses?: AutoReviewStatus[];
  reviewRiskLevels?: AutoReviewRiskLevel[];
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
  cancellationRate?: number;
  skipRate?: number;
  duration: { count: number; sumMs: number; minMs?: number; maxMs?: number };
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    inputTokenRecords: number;
    outputTokenRecords: number;
    totalTokenRecords: number;
    averageInputTokens?: number;
    averageOutputTokens?: number;
    averageTotalTokens?: number;
    completeRecords: number;
    partialRecords: number;
    unknownRecords: number;
  };
  failures: Partial<Record<ExecutionFailureKind, number>>;
  reviews: Partial<Record<AutoReviewStatus, number>>;
}

export interface ExecutionObservationExport {
  schemaVersion: 1;
  generatedAt: number;
  filters: ExecutionObservationFilter;
  summary: Partial<Record<ExecutionKind, ExecutionKindSummary>>;
  records: ExecutionObservation[];
  warnings: ExecutionObservationWarning[];
}
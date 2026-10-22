import { EXECUTION_KINDS, EXECUTION_FAILURE_KINDS, AUTO_REVIEW_STATUSES } from "@vykor/protocol";
import type * as Wire from "@vykor/protocol";
import type * as App from "../../application/observability/query-models.js";

export function executionObservationDto(input: App.ExecutionObservationExport): Wire.ExecutionObservationExport {
  const summary: Wire.ExecutionObservationExport["summary"] = {};
  for (const kind of EXECUTION_KINDS) {
    const item = input.summary[kind];
    if (item) summary[kind] = executionSummaryDto(item);
  }
  const filter = input.filters;
  return { schemaVersion: input.schemaVersion, generatedAt: input.generatedAt,
    filters: { from: filter.from, to: filter.to, executionKinds: filter.executionKinds, outcomes: filter.outcomes,
      failureKinds: filter.failureKinds, sessionId: filter.sessionId, runId: filter.runId, childId: filter.childId,
      workflowRunId: filter.workflowRunId, workflowTaskId: filter.workflowTaskId, model: filter.model, provider: filter.provider,
      reviewStatuses: filter.reviewStatuses, reviewRiskLevels: filter.reviewRiskLevels }, summary,
    records: input.records.map(item => ({ schemaVersion: item.schemaVersion, executionKind: item.executionKind, executionId: item.executionId,
      parentExecutionId: item.parentExecutionId, backingExecutionIds: item.backingExecutionIds, traceId: item.traceId,
      sessionId: item.sessionId, runId: item.runId, childId: item.childId, childSessionId: item.childSessionId,
      workflowRunId: item.workflowRunId, workflowTaskId: item.workflowTaskId, model: item.model, provider: item.provider,
      workflowMode: item.workflowMode, configuredConcurrency: item.configuredConcurrency, attemptCount: item.attemptCount,
      createdAt: item.createdAt, startedAt: item.startedAt, finishedAt: item.finishedAt, durationMs: item.durationMs,
      outcome: item.outcome, failureKind: item.failureKind, completeness: item.completeness,
      usage: { inputTokens: item.usage.inputTokens, outputTokens: item.usage.outputTokens, totalTokens: item.usage.totalTokens,
        cacheReadTokens: item.usage.cacheReadTokens, cacheCreationTokens: item.usage.cacheCreationTokens, completeness: item.usage.completeness },
      source: { kind: item.source.kind, id: item.source.id },
      ...(item.review ? { review: { policyVersion: item.review.policyVersion, riskLevel: item.review.riskLevel,
        status: item.review.status, verdict: item.review.verdict, findingCount: item.review.findingCount } } : {}) })),
    warnings: input.warnings.map(item => ({ code: item.code, sourceId: item.sourceId })) };
}
function executionSummaryDto(input: App.ExecutionKindSummary): Wire.ExecutionKindSummary {
  const failures: Wire.ExecutionKindSummary["failures"] = {}, reviews: Wire.ExecutionKindSummary["reviews"] = {};
  for (const kind of EXECUTION_FAILURE_KINDS) if (input.failures[kind] !== undefined) failures[kind] = input.failures[kind];
  for (const status of AUTO_REVIEW_STATUSES) if (input.reviews[status] !== undefined) reviews[status] = input.reviews[status];
  const usage = input.usage;
  return { total: input.total, technicalTerminal: input.technicalTerminal, completed: input.completed, failed: input.failed,
    timedOut: input.timedOut, cancelled: input.cancelled, blocked: input.blocked, skipped: input.skipped, unknown: input.unknown,
    completionRate: input.completionRate, failureRate: input.failureRate, cancellationRate: input.cancellationRate, skipRate: input.skipRate,
    duration: { count: input.duration.count, sumMs: input.duration.sumMs, minMs: input.duration.minMs, maxMs: input.duration.maxMs },
    usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, totalTokens: usage.totalTokens,
      inputTokenRecords: usage.inputTokenRecords, outputTokenRecords: usage.outputTokenRecords, totalTokenRecords: usage.totalTokenRecords,
      averageInputTokens: usage.averageInputTokens, averageOutputTokens: usage.averageOutputTokens, averageTotalTokens: usage.averageTotalTokens,
      completeRecords: usage.completeRecords, partialRecords: usage.partialRecords, unknownRecords: usage.unknownRecords }, failures, reviews };
}

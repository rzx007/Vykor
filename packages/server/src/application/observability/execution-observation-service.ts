import {
  EXECUTION_KINDS,
  type ExecutionKind,
  type ExecutionKindSummary,
  type ExecutionObservation,
  type ExecutionObservationExport,
  type ExecutionObservationFilter,
  type ExecutionObservationWarning,
} from "@vykor/protocol";

import type { SessionObservationReadResult } from "./session-execution-observation-reader.js";
import type { WorkflowObservationReadResult } from "./workflow-execution-observation-reader.js";

export interface ExecutionObservationServiceInput {
  readSessions(): SessionObservationReadResult;
  readWorkflows(backing: ReadonlyMap<string, string[]>): WorkflowObservationReadResult;
  now?: () => number;
}

/**
 * 合并两个只读 Reader，按过滤条件查询、稳定排序并按 `executionKind` 聚合。
 * 不生成跨 kind 总计；缺少分母时省略比率字段；记录在导出前收敛到已知字段。
 */
export class ExecutionObservationService {
  constructor(private readonly input: ExecutionObservationServiceInput) {}

  query(filter: ExecutionObservationFilter): ExecutionObservationExport {
    const sessionRead = this.input.readSessions();
    const workflowRead = this.input.readWorkflows(sessionRead.backingExecutionsByTaskId);
    const warnings = dedupeWarnings([...sessionRead.warnings, ...workflowRead.warnings]);
    const records = [...sessionRead.records, ...workflowRead.records]
      .map(sanitizeRecord)
      .filter((record) => matchesFilter(record, filter))
      .sort(compareRecords);

    return {
      schemaVersion: 1,
      generatedAt: (this.input.now ?? Date.now)(),
      filters: filter,
      summary: summarizeByKind(records),
      records,
      warnings,
    };
  }
}

function timeBoundary(record: ExecutionObservation): number | undefined {
  return record.startedAt ?? record.createdAt;
}

function matchesFilter(record: ExecutionObservation, filter: ExecutionObservationFilter): boolean {
  if (filter.from !== undefined || filter.to !== undefined) {
    const boundary = timeBoundary(record);
    if (boundary === undefined) return false;
    if (filter.from !== undefined && boundary < filter.from) return false;
    if (filter.to !== undefined && boundary > filter.to) return false;
  }
  if (filter.executionKinds && !filter.executionKinds.includes(record.executionKind)) return false;
  if (filter.outcomes && !filter.outcomes.includes(record.outcome)) return false;
  if (
    filter.failureKinds &&
    (record.failureKind === undefined || !filter.failureKinds.includes(record.failureKind))
  ) {
    return false;
  }
  if (filter.sessionId !== undefined && record.sessionId !== filter.sessionId) return false;
  if (filter.runId !== undefined && record.runId !== filter.runId) return false;
  if (filter.childId !== undefined && record.childId !== filter.childId) return false;
  if (filter.workflowRunId !== undefined && record.workflowRunId !== filter.workflowRunId) return false;
  if (filter.workflowTaskId !== undefined && record.workflowTaskId !== filter.workflowTaskId) return false;
  if (filter.model !== undefined && record.model !== filter.model) return false;
  if (filter.provider !== undefined && record.provider !== filter.provider) return false;
  return true;
}

function compareRecords(left: ExecutionObservation, right: ExecutionObservation): number {
  const leftBoundary = timeBoundary(left);
  const rightBoundary = timeBoundary(right);
  if (leftBoundary === undefined && rightBoundary === undefined) {
    return left.executionId.localeCompare(right.executionId);
  }
  if (leftBoundary === undefined) return 1;
  if (rightBoundary === undefined) return -1;
  if (leftBoundary !== rightBoundary) return leftBoundary - rightBoundary;
  return left.executionId.localeCompare(right.executionId);
}

function summarizeByKind(
  records: ExecutionObservation[],
): Partial<Record<ExecutionKind, ExecutionKindSummary>> {
  const summary: Partial<Record<ExecutionKind, ExecutionKindSummary>> = {};
  for (const kind of EXECUTION_KINDS) {
    const group = records.filter((record) => record.executionKind === kind);
    if (group.length > 0) summary[kind] = summarize(group);
  }
  return summary;
}

function summarize(records: ExecutionObservation[]): ExecutionKindSummary {
  const summary: ExecutionKindSummary = {
    total: records.length,
    technicalTerminal: 0,
    completed: 0,
    failed: 0,
    timedOut: 0,
    cancelled: 0,
    blocked: 0,
    skipped: 0,
    unknown: 0,
    duration: { count: 0, sumMs: 0 },
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      completeRecords: 0,
      partialRecords: 0,
      unknownRecords: 0,
    },
    failures: {},
  };

  let minMs: number | undefined;
  let maxMs: number | undefined;
  for (const record of records) {
    switch (record.outcome) {
      case "completed":
        summary.completed += 1;
        break;
      case "failed":
        summary.failed += 1;
        break;
      case "timed_out":
        summary.timedOut += 1;
        break;
      case "cancelled":
        summary.cancelled += 1;
        break;
      case "blocked":
        summary.blocked += 1;
        break;
      case "skipped":
        summary.skipped += 1;
        break;
      case "unknown":
        summary.unknown += 1;
        break;
      default:
        break;
    }

    if (record.durationMs !== undefined) {
      summary.duration.count += 1;
      summary.duration.sumMs += record.durationMs;
      minMs = minMs === undefined ? record.durationMs : Math.min(minMs, record.durationMs);
      maxMs = maxMs === undefined ? record.durationMs : Math.max(maxMs, record.durationMs);
    }
    if (record.usage.inputTokens !== undefined) summary.usage.inputTokens += record.usage.inputTokens;
    if (record.usage.outputTokens !== undefined) summary.usage.outputTokens += record.usage.outputTokens;
    if (record.usage.completeness === "complete") summary.usage.completeRecords += 1;
    else if (record.usage.completeness === "partial") summary.usage.partialRecords += 1;
    else summary.usage.unknownRecords += 1;

    if (record.failureKind !== undefined) {
      summary.failures[record.failureKind] = (summary.failures[record.failureKind] ?? 0) + 1;
    }
  }

  summary.technicalTerminal = summary.completed + summary.failed + summary.timedOut;
  if (summary.technicalTerminal > 0) {
    summary.completionRate = summary.completed / summary.technicalTerminal;
    summary.failureRate = (summary.failed + summary.timedOut) / summary.technicalTerminal;
  }
  if (minMs !== undefined) summary.duration.minMs = minMs;
  if (maxMs !== undefined) summary.duration.maxMs = maxMs;
  return summary;
}

function dedupeWarnings(warnings: ExecutionObservationWarning[]): ExecutionObservationWarning[] {
  const seen = new Set<string>();
  const deduped: ExecutionObservationWarning[] = [];
  for (const warning of warnings) {
    const key = `${warning.code}\0${warning.sourceId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push({ code: warning.code, sourceId: warning.sourceId });
  }
  return deduped;
}

function sanitizeRecord(record: ExecutionObservation): ExecutionObservation {
  return {
    schemaVersion: 1,
    executionKind: record.executionKind,
    executionId: record.executionId,
    ...(record.parentExecutionId !== undefined ? { parentExecutionId: record.parentExecutionId } : {}),
    ...(record.backingExecutionIds ? { backingExecutionIds: [...record.backingExecutionIds] } : {}),
    ...(record.traceId !== undefined ? { traceId: record.traceId } : {}),
    ...(record.sessionId !== undefined ? { sessionId: record.sessionId } : {}),
    ...(record.runId !== undefined ? { runId: record.runId } : {}),
    ...(record.childId !== undefined ? { childId: record.childId } : {}),
    ...(record.childSessionId !== undefined ? { childSessionId: record.childSessionId } : {}),
    ...(record.workflowRunId !== undefined ? { workflowRunId: record.workflowRunId } : {}),
    ...(record.workflowTaskId !== undefined ? { workflowTaskId: record.workflowTaskId } : {}),
    ...(record.model !== undefined ? { model: record.model } : {}),
    ...(record.provider !== undefined ? { provider: record.provider } : {}),
    ...(record.workflowMode !== undefined ? { workflowMode: record.workflowMode } : {}),
    ...(record.configuredConcurrency !== undefined ? { configuredConcurrency: record.configuredConcurrency } : {}),
    ...(record.attemptCount !== undefined ? { attemptCount: record.attemptCount } : {}),
    ...(record.createdAt !== undefined ? { createdAt: record.createdAt } : {}),
    ...(record.startedAt !== undefined ? { startedAt: record.startedAt } : {}),
    ...(record.finishedAt !== undefined ? { finishedAt: record.finishedAt } : {}),
    ...(record.durationMs !== undefined ? { durationMs: record.durationMs } : {}),
    outcome: record.outcome,
    ...(record.failureKind !== undefined ? { failureKind: record.failureKind } : {}),
    usage: {
      ...(record.usage.inputTokens !== undefined ? { inputTokens: record.usage.inputTokens } : {}),
      ...(record.usage.outputTokens !== undefined ? { outputTokens: record.usage.outputTokens } : {}),
      ...(record.usage.cacheReadTokens !== undefined ? { cacheReadTokens: record.usage.cacheReadTokens } : {}),
      ...(record.usage.cacheCreationTokens !== undefined
        ? { cacheCreationTokens: record.usage.cacheCreationTokens }
        : {}),
      completeness: record.usage.completeness,
    },
    source: { kind: record.source.kind, id: record.source.id },
    completeness: record.completeness,
  };
}

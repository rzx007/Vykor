import type {
  ExecutionObservation,
  ExecutionObservationWarning,
  ExecutionUsageCompleteness,
} from "@vykor/protocol";
import type {
  WorkflowEventReadResult,
  WorkflowReadDiagnostic,
  WorkflowRunEvent,
  WorkflowRunSnapshot,
  WorkflowSnapshotReadResult,
  WorkflowTaskTerminalStatus,
} from "@vykor/coordinator";

export interface WorkflowObservationSource {
  listWithDiagnostics(): WorkflowSnapshotReadResult;
  loadEventsWithDiagnostics(runId: string): WorkflowEventReadResult;
}

export interface WorkflowObservationReadResult {
  records: ExecutionObservation[];
  warnings: ExecutionObservationWarning[];
}

/**
 * 只读投影 Workflow snapshot 与持久事件。每个 snapshot 生成一条 Workflow Run，
 * `plan.tasks` 的每个元素生成且只生成一条 Workflow Task；时间只取自可证明的持久事件。
 */
export function readWorkflowExecutionObservations(
  source: WorkflowObservationSource,
  backingExecutionsByTaskId: ReadonlyMap<string, string[]>,
): WorkflowObservationReadResult {
  const records: ExecutionObservation[] = [];
  const warnings: ExecutionObservationWarning[] = [];
  const { snapshots, diagnostics } = source.listWithDiagnostics();
  for (const diagnostic of diagnostics) warnings.push(toWarning(diagnostic));

  for (const snapshot of snapshots) {
    const eventRead = source.loadEventsWithDiagnostics(snapshot.runId);
    for (const diagnostic of eventRead.diagnostics) warnings.push(toWarning(diagnostic));

    const taskRecords = snapshot.plan.tasks.map((task) =>
      projectTask(snapshot, task.id, backingExecutionsByTaskId, warnings),
    );
    records.push(projectRun(
      snapshot,
      eventRead.events,
      eventRead.diagnostics.length > 0,
      taskRecords,
      warnings,
    ));
    records.push(...taskRecords);
  }

  return { records, warnings };
}

function projectRun(
  snapshot: WorkflowRunSnapshot,
  events: WorkflowRunEvent[],
  hasEventDiagnostic: boolean,
  taskRecords: ExecutionObservation[],
  warnings: ExecutionObservationWarning[],
): ExecutionObservation {
  const startedAt = hasEventDiagnostic ? undefined : earliestStarted(events);
  const finishedAt = hasEventDiagnostic ? undefined : latestTerminal(events);
  const durationMs =
    startedAt !== undefined && finishedAt !== undefined
      ? Math.max(0, finishedAt - startedAt)
      : undefined;
  const completeness =
    startedAt !== undefined && finishedAt !== undefined && !hasEventDiagnostic
      ? "complete"
      : "partial";
  const ownerRun = readNonEmptyString(snapshot.ownerRun);
  const ownerSession = readNonEmptyString(snapshot.ownerSession);
  const usage = aggregateUsage(taskRecords);
  const outcome = mapRunOutcome(snapshot);
  if (usage.completeness === "partial" ||
      (usage.completeness === "unknown" && outcome !== "running")) {
    warnings.push({ code: "partial_usage", sourceId: `workflow:${snapshot.runId}` });
  }

  return {
    schemaVersion: 1,
    executionKind: "workflow_run",
    executionId: `workflow:${snapshot.runId}`,
    ...(ownerRun ? { parentExecutionId: `agent-run:${ownerRun}` } : {}),
    ...(ownerSession ? { sessionId: ownerSession } : {}),
    workflowRunId: snapshot.runId,
    workflowMode: snapshot.plan.mode,
    ...(typeof snapshot.plan.maxConcurrency === "number"
      ? { configuredConcurrency: snapshot.plan.maxConcurrency }
      : {}),
    createdAt: snapshot.createdAt,
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(finishedAt !== undefined ? { finishedAt } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    outcome,
    usage,
    source: { kind: "workflow_snapshot", id: snapshot.runId },
    completeness,
  };
}

function mapRunOutcome(snapshot: WorkflowRunSnapshot): ExecutionObservation["outcome"] {
  if (snapshot.termination === "cancelled") return "cancelled";
  switch (snapshot.status) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "running":
      return "running";
  }
}

function projectTask(
  snapshot: WorkflowRunSnapshot,
  taskId: string,
  backingExecutionsByTaskId: ReadonlyMap<string, string[]>,
  warnings: ExecutionObservationWarning[],
): ExecutionObservation {
  const result = snapshot.results[taskId];
  const running = snapshot.runningTasks[taskId];
  const blocked = snapshot.blockedTasks[taskId];

  const executionId = `workflow-task:${snapshot.runId}:${taskId}`;
  const base = {
    schemaVersion: 1 as const,
    executionKind: "workflow_task" as const,
    executionId,
    parentExecutionId: `workflow:${snapshot.runId}`,
    workflowRunId: snapshot.runId,
    workflowTaskId: taskId,
    createdAt: snapshot.createdAt,
    source: { kind: "workflow_snapshot" as const, id: snapshot.runId },
  };

  if (result) {
    const backing = readBacking(result.metadata, executionId, backingExecutionsByTaskId, warnings);
    const usage = readTaskUsage(result.budget, result.metadata);
    if (usage.completeness === "partial" ||
        (usage.completeness === "unknown" && result.status !== "skipped")) {
      warnings.push({ code: "partial_usage", sourceId: executionId });
    }
    const retryBackingIncomplete =
      result.attempts > 1 && result.metadata?.backingExecutionsCumulativeAcrossAttempts !== true;
    return {
      ...base,
      ...(backing.ids ? { backingExecutionIds: backing.ids } : {}),
      attemptCount: result.attempts,
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      durationMs: Math.max(0, result.finishedAt - result.startedAt),
      outcome: result.timedOut === true ? "timed_out" : mapTaskStatus(result.status),
      ...(result.timedOut === true
        ? { failureKind: "timeout" as const }
        : result.status === "failed"
          ? { failureKind: "unknown" as const }
          : {}),
      usage,
      completeness: backing.completeness === "partial" || retryBackingIncomplete ? "partial" : "complete",
    };
  }

  if (running) {
    const backing = readBacking(running.metadata, executionId, backingExecutionsByTaskId, warnings);
    const usage = readTaskUsage(running.budget, running.metadata);
    if (usage.completeness === "partial") {
      warnings.push({ code: "partial_usage", sourceId: executionId });
    }
    const retryBackingIncomplete =
      running.attempt > 1 && running.metadata?.backingExecutionsCumulativeAcrossAttempts !== true;
    return {
      ...base,
      ...(backing.ids ? { backingExecutionIds: backing.ids } : {}),
      attemptCount: running.attempt,
      startedAt: running.startedAt,
      outcome: "running",
      usage,
      completeness: backing.completeness === "partial" || retryBackingIncomplete ? "partial" : "complete",
    };
  }

  if (blocked) {
    return {
      ...base,
      outcome: "blocked",
      usage: { completeness: "unknown" },
      completeness: "complete",
    };
  }

  return {
    ...base,
    outcome: "pending",
    usage: { completeness: "unknown" },
    completeness: "complete",
  };
}

function mapTaskStatus(status: WorkflowTaskTerminalStatus): ExecutionObservation["outcome"] {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "killed":
      return "cancelled";
    case "skipped":
      return "skipped";
  }
}

function readBacking(
  metadata: Record<string, unknown> | undefined,
  executionId: string,
  backingExecutionsByTaskId: ReadonlyMap<string, string[]>,
  warnings: ExecutionObservationWarning[],
): { ids?: string[]; completeness: "complete" | "partial" } {
  const workerTaskId = readNonEmptyString(metadata?.workerTaskId);
  if (!workerTaskId) return { completeness: "complete" };
  const ids = backingExecutionsByTaskId.get(workerTaskId);
  if (ids && ids.length > 0) return { ids: [...ids], completeness: "complete" };
  warnings.push({ code: "missing_backing_execution", sourceId: executionId });
  return { completeness: "partial" };
}

function readTaskUsage(
  budget: { tokensUsed?: number } | undefined,
  metadata: Record<string, unknown> | undefined,
): ExecutionObservation["usage"] {
  const tokensUsed = readNonNegativeInteger(budget?.tokensUsed);
  if (tokensUsed === undefined) return { completeness: "unknown" };
  const cumulative = metadata?.budgetCumulativeAcrossAttempts === true;
  return {
    totalTokens: tokensUsed,
    completeness: cumulative ? "complete" : "partial",
  };
}

function aggregateUsage(records: ExecutionObservation[]): ExecutionObservation["usage"] {
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let hasInputTokens = false;
  let hasOutputTokens = false;
  let hasTotalTokens = false;
  let completeness: ExecutionUsageCompleteness = "complete";
  for (const record of records) {
    if (record.usage.inputTokens !== undefined) {
      inputTokens += record.usage.inputTokens;
      hasInputTokens = true;
    }
    if (record.usage.outputTokens !== undefined) {
      outputTokens += record.usage.outputTokens;
      hasOutputTokens = true;
    }
    if (record.usage.totalTokens !== undefined) {
      totalTokens += record.usage.totalTokens;
      hasTotalTokens = true;
    }
    completeness = worseUsageCompleteness(completeness, record.usage.completeness);
  }
  if (records.length === 0) completeness = "unknown";
  return {
    ...(hasInputTokens ? { inputTokens } : {}),
    ...(hasOutputTokens ? { outputTokens } : {}),
    ...(hasTotalTokens ? { totalTokens } : {}),
    completeness,
  };
}

function worseUsageCompleteness(
  left: ExecutionUsageCompleteness,
  right: ExecutionUsageCompleteness,
): ExecutionUsageCompleteness {
  const rank: Record<ExecutionUsageCompleteness, number> = {
    complete: 0,
    partial: 1,
    unknown: 2,
  };
  return rank[left] >= rank[right] ? left : right;
}

function earliestStarted(events: WorkflowRunEvent[]): number | undefined {
  let earliest: number | undefined;
  for (const event of events) {
    if (event.type !== "workflow_started") continue;
    if (earliest === undefined || event.timestamp < earliest) earliest = event.timestamp;
  }
  return earliest;
}

function latestTerminal(events: WorkflowRunEvent[]): number | undefined {
  let latest: number | undefined;
  for (const event of events) {
    if (event.type !== "workflow_finished" && event.type !== "workflow_cancelled") continue;
    if (latest === undefined || event.timestamp > latest) latest = event.timestamp;
  }
  return latest;
}

function toWarning(diagnostic: WorkflowReadDiagnostic): ExecutionObservationWarning {
  return { code: diagnostic.code, sourceId: diagnostic.sourceId };
}

function readNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

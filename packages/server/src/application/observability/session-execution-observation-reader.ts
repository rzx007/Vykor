import {
  readSessionModelUsage,
  type ExecutionObservation,
  type ExecutionObservationWarning,
  type ExecutionOutcome,
  type ExecutionUsageCompleteness,
  type RunStatus,
  type SessionExecutionRecord,
  type SessionRecord,
  type SessionRunAttemptRecord,
  type SessionRunRecord,
} from "@vykor/protocol";

export interface SessionObservationSource {
  listSessions(): SessionRecord[];
  listRuns(sessionId: string): SessionRunRecord[];
  listRunAttempts(runId: string): SessionRunAttemptRecord[];
  listSessionTasks(sessionId: string): SessionExecutionRecord[];
}

export interface SessionObservationReadResult {
  records: ExecutionObservation[];
  warnings: ExecutionObservationWarning[];
  backingExecutionsByTaskId: Map<string, string[]>;
}

/**
 * 只读投影 Session Run、attempt、Child Session/Task 为统一执行观测记录。
 * 不读取 prompt、输出或错误正文；无法由结构化字段证明的分类保持 `unknown`。
 */
export function readSessionExecutionObservations(
  source: SessionObservationSource,
): SessionObservationReadResult {
  const records: ExecutionObservation[] = [];
  const warnings: ExecutionObservationWarning[] = [];
  const backingExecutionsByTaskId = new Map<string, string[]>();
  const sessions = source.listSessions();

  for (const session of sessions) {
    for (const run of source.listRuns(session.id)) {
      const projected = projectRun(source, session, run);
      records.push(projected.record);
      warnings.push(...projected.warnings);
    }
    for (const task of source.listSessionTasks(session.id)) {
      if (!task.childSessionId) continue;
      const backing = source
        .listRuns(task.childSessionId)
        .map((run) => agentExecutionId(run.id));
      if (backing.length > 0) backingExecutionsByTaskId.set(task.id, backing);
    }
  }

  return { records, warnings, backingExecutionsByTaskId };
}

function projectRun(
  source: SessionObservationSource,
  session: SessionRecord,
  run: SessionRunRecord,
): { record: ExecutionObservation; warnings: ExecutionObservationWarning[] } {
  const warnings: ExecutionObservationWarning[] = [];
  const executionId = agentExecutionId(run.id);
  const attempts = source.listRunAttempts(run.id);
  const finalAttempt = readFinalAttempt(attempts);
  const childId = readNonEmptyString(session.metadata.childId);
  const isChild = session.parentId !== undefined && childId !== undefined;

  let parentExecutionId: string | undefined;
  let completeness: "complete" | "partial" = "complete";
  if (isChild) {
    const parentRunId = readNonEmptyString(run.metadata.parentRunId);
    if (parentRunId) {
      parentExecutionId = agentExecutionId(parentRunId);
    } else {
      completeness = "partial";
      warnings.push({ code: "missing_parent_execution", sourceId: executionId });
    }
  }

  const durationMs =
    run.startedAt !== undefined && run.finishedAt !== undefined
      ? Math.max(0, run.finishedAt - run.startedAt)
      : undefined;

  const record: ExecutionObservation = {
    schemaVersion: 1,
    executionKind: isChild ? "child_agent_run" : "root_agent_run",
    executionId,
    ...(parentExecutionId ? { parentExecutionId } : {}),
    ...(readNonEmptyString(run.metadata.traceId) !== undefined
      ? { traceId: readNonEmptyString(run.metadata.traceId)! }
      : {}),
    sessionId: run.sessionId,
    runId: run.id,
    ...(isChild && childId ? { childId, childSessionId: run.sessionId } : {}),
    ...(finalAttempt?.model ? { model: finalAttempt.model } : {}),
    ...(finalAttempt?.provider ? { provider: finalAttempt.provider } : {}),
    attemptCount: attempts.length,
    createdAt: run.createdAt,
    ...(run.startedAt !== undefined ? { startedAt: run.startedAt } : {}),
    ...(run.finishedAt !== undefined ? { finishedAt: run.finishedAt } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    outcome: mapRunOutcome(run.status),
    usage: readUsage(run.metadata),
    source: { kind: "session_run", id: run.id },
    completeness,
  };
  return { record, warnings };
}

function agentExecutionId(runId: string): string {
  return `agent-run:${runId}`;
}

function mapRunOutcome(status: RunStatus): ExecutionOutcome {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "pending":
      return "pending";
    case "running":
      return "running";
    case "interrupted":
      return "unknown";
  }
}

function readFinalAttempt(
  attempts: SessionRunAttemptRecord[],
): SessionRunAttemptRecord | undefined {
  let final: SessionRunAttemptRecord | undefined;
  for (const attempt of attempts) {
    if (!isFinishedAttempt(attempt)) continue;
    if (!final || attempt.sequence > final.sequence) final = attempt;
  }
  return final;
}

function isFinishedAttempt(attempt: SessionRunAttemptRecord): boolean {
  return (
    attempt.status === "completed" ||
    attempt.status === "failed" ||
    attempt.status === "cancelled"
  );
}

function readUsage(metadata: Record<string, unknown>): ExecutionObservation["usage"] {
  const usage = readRecord(metadata.usage);
  const modelUsage = readSessionModelUsage(metadata);
  const completeness: ExecutionUsageCompleteness =
    !usage && !modelUsage
      ? "unknown"
      : modelUsage?.incomplete ||
          (modelUsage?.unknownAttempts ?? 0) > 0 ||
          (modelUsage?.partialAttempts ?? 0) > 0
        ? "partial"
        : "complete";

  const inputTokens = readNonNegativeInteger(usage?.inputTokens);
  const outputTokens = readNonNegativeInteger(usage?.outputTokens);
  const cacheReadTokens = readNonNegativeInteger(usage?.cacheReadTokens);
  const cacheCreationTokens = readNonNegativeInteger(usage?.cacheCreationTokens);
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheCreationTokens !== undefined ? { cacheCreationTokens } : {}),
    completeness,
  };
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function readNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

import type { ModelTokenMetering } from "@vykor/agent-contracts";
import type { GoalModelAttemptKey, GoalUsage, SessionGoal } from "@vykor/domain-contracts/goals";
import type { SessionRunRecord } from "@vykor/domain-contracts/sessions";
import { and, eq } from "drizzle-orm";
import type { StorageContext } from "../database/storage-context.js";
import { sessionGoalModelAttempts } from "../session-runtime/schema.js";

export type GoalAttemptStart = GoalModelAttemptKey & {
  sessionId: string;
  provider?: string;
  model: string;
  purpose:
    | "generation"
    | "compaction"
    | "finalization"
    | "memory"
    | "plugin_selection";
};

export type GoalAttemptReport = GoalModelAttemptKey & {
  sessionId: string;
  status: "completed" | "failed" | "interrupted";
  usageStatus: "complete" | "partial" | "unknown";
  metering?: ModelTokenMetering;
  notDispatched?: true;
};

export type GoalModelAttemptRow = typeof sessionGoalModelAttempts.$inferSelect;
export type GoalBudgetStopCode = "token_budget" | "usage_unknown";

export function goalBudgetStopCode(
  goal: Pick<SessionGoal, "tokenBudget">,
  usage: GoalUsage,
): GoalBudgetStopCode | undefined {
  if (goal.tokenBudget === undefined) return undefined;
  if (usage.knownTokens >= goal.tokenBudget) return "token_budget";
  if (usage.incomplete) return "usage_unknown";
  return undefined;
}

function attemptMapKey(key: GoalModelAttemptKey): string {
  return JSON.stringify([key.runId, key.generationId, key.attempt]);
}

export function assertGoalAttemptKey(key: GoalModelAttemptKey): void {
  if (
    !key.runId ||
    !key.generationId ||
    !Number.isSafeInteger(key.attempt) ||
    key.attempt < 1
  )
    throw new Error("invalid_goal_model_attempt_key");
}

export function getGoalModelAttempt(
  storage: StorageContext,
  key: GoalModelAttemptKey,
): GoalModelAttemptRow | undefined {
  return (
    storage.temporaryControls?.goalModelAttempts.get(attemptMapKey(key)) ??
    storage.database.orm
      .select()
      .from(sessionGoalModelAttempts)
      .where(
        and(
          eq(sessionGoalModelAttempts.runId, key.runId),
          eq(sessionGoalModelAttempts.generationId, key.generationId),
          eq(sessionGoalModelAttempts.attempt, key.attempt),
        ),
      )
      .get()
  );
}

export function listGoalModelAttempts(
  storage: StorageContext,
  goalId?: string,
  includeTemporary = true,
): GoalModelAttemptRow[] {
  const stored = storage.database.orm
    .select()
    .from(sessionGoalModelAttempts)
    .where(
      goalId === undefined
        ? undefined
        : eq(sessionGoalModelAttempts.goalId, goalId),
    )
    .all();
  if (!includeTemporary) return stored;
  return [
    ...stored,
    ...[
      ...(storage.temporaryControls?.goalModelAttempts.values() ?? []),
    ].filter((row) => goalId === undefined || row.goalId === goalId),
  ];
}

export function saveGoalModelAttempt(
  storage: StorageContext,
  row: GoalModelAttemptRow,
): void {
  // Ownership follows the root Goal, including attempts made in a durable Child chat.
  if (storage.temporaryControls?.goals.has(row.goalId)) {
    const records = storage.temporaryControls;
    const key = attemptMapKey(row);
    records.capture(records.goalModelAttempts, key);
    records.goalModelAttempts.set(key, row);
    return;
  }
  storage.database.orm
    .insert(sessionGoalModelAttempts)
    .values(row)
    .onConflictDoUpdate({
      target: [
        sessionGoalModelAttempts.runId,
        sessionGoalModelAttempts.generationId,
        sessionGoalModelAttempts.attempt,
      ],
      set: row,
    })
    .run();
}

function validTokens(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/** Reports are cumulative snapshots of one attempt; older partial snapshots cannot change a complete row. */
export function mergeGoalModelAttempt(
  row: GoalModelAttemptRow,
  report: GoalAttemptReport,
): GoalModelAttemptRow {
  const metering = report.metering;
  const inputValid = validTokens(metering?.knownInputTokens);
  const outputValid = validTokens(metering?.knownOutputTokens);
  const validComplete =
    report.usageStatus === "complete" &&
    metering?.completeness === "complete" &&
    inputValid &&
    outputValid &&
    Number.isSafeInteger(
      metering.knownInputTokens + metering.knownOutputTokens,
    );
  const undispatched =
    report.notDispatched === true &&
    row.knownInputTokens === 0 &&
    row.knownOutputTokens === 0;
  if (row.state === "complete" && !validComplete && !undispatched) return row;
  const input = undispatched ? 0 : inputValid ? metering!.knownInputTokens : 0;
  const output = undispatched
    ? 0
    : outputValid
      ? metering!.knownOutputTokens
      : 0;
  const complete = validComplete || undispatched;
  const knownInputTokens = Math.max(row.knownInputTokens, input);
  const knownOutputTokens = Math.max(row.knownOutputTokens, output);
  const inconsistent = complete
    ? input < row.knownInputTokens || output < row.knownOutputTokens
    : row.inconsistent;
  const hasPartial =
    knownInputTokens > 0 ||
    knownOutputTokens > 0 ||
    report.usageStatus === "partial" ||
    (metering?.completeness === "partial" && (inputValid || outputValid));
  const next: GoalModelAttemptRow = {
    ...row,
    knownInputTokens,
    knownOutputTokens,
    inconsistent,
    state: complete ? "complete" : hasPartial ? "partial" : "unknown",
    rawUsageJson: metering ? JSON.stringify(metering.raw) : row.rawUsageJson,
    finishedAt: row.finishedAt ?? Date.now(),
  };
  return JSON.stringify(next) === JSON.stringify(row) ? row : next;
}

export function summarizeGoalUsage(
  rows: GoalModelAttemptRow[],
  runs: SessionRunRecord[],
  previous: GoalUsage,
): GoalUsage {
  let knownTokens = 0;
  let incomplete = false;
  let unknownAttempts = 0;
  let partialAttempts = 0;
  let inFlightAttempts = 0;
  for (const row of rows) {
    for (const amount of [row.knownInputTokens, row.knownOutputTokens]) {
      if (amount <= Number.MAX_SAFE_INTEGER - knownTokens)
        knownTokens += amount;
      else {
        // The exact count remains in the rows; this is a provable lower bound, never a budget-clipped total.
        knownTokens = Number.MAX_SAFE_INTEGER;
        incomplete = true;
      }
    }
    if (row.state === "pending") inFlightAttempts++;
    if (row.state === "unknown") unknownAttempts++;
    if (row.state === "partial") partialAttempts++;
    incomplete ||=
      row.inconsistent || row.state === "unknown" || row.state === "partial";
  }
  const runTimeMs = runs.reduce(
    (sum, run) =>
      sum +
      (!run.metadata.parentRunId &&
      run.startedAt !== undefined &&
      run.finishedAt !== undefined
        ? Math.max(0, run.finishedAt - run.startedAt)
        : 0),
    0,
  );
  return {
    knownTokens,
    incomplete,
    unknownAttempts,
    partialAttempts,
    inFlightAttempts,
    runTimeMs,
    seq: previous.seq,
    updatedAt: previous.updatedAt,
  };
}

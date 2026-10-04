import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNotNull, lt, ne, notExists, notInArray, placeholder, sql } from "drizzle-orm";
import type { SessionDatabase } from "../database/session-database.js";
import {
  projectionSettlements,
  retentionAudits,
  sessionEvents,
  sessionRunAttempts,
  sessionRuns,
  sessions,
  workflowEvents,
  workflowExecutionClaims,
  workflowRuns,
} from "./schema.js";
import { now, type SessionState } from "./store-state.js";

export interface RetentionPolicy {
  durableEventMaxAgeMs: number;
  workflowEventMaxAgeMs: number;
  workflowRunMaxAgeMs: number;
  runAttemptMaxAgeMs: number;
  projectionSettlementMaxAgeMs: number;
  completedJobVisibleForMs: number;
  terminalOutputMaxBytes: number;
  attachmentGracePeriodMs: number;
}

export const DEFAULT_RETENTION_POLICY: RetentionPolicy = {
  durableEventMaxAgeMs: 30 * 24 * 60 * 60 * 1_000,
  workflowEventMaxAgeMs: 30 * 24 * 60 * 60 * 1_000,
  workflowRunMaxAgeMs: 90 * 24 * 60 * 60 * 1_000,
  runAttemptMaxAgeMs: 90 * 24 * 60 * 60 * 1_000,
  projectionSettlementMaxAgeMs: 30 * 24 * 60 * 60 * 1_000,
  completedJobVisibleForMs: 7 * 24 * 60 * 60 * 1_000,
  terminalOutputMaxBytes: 10 * 1024 * 1024,
  attachmentGracePeriodMs: 7 * 24 * 60 * 60 * 1_000,
};

export function applyRetention(
  database: SessionDatabase["orm"],
  state: SessionState,
  policy: RetentionPolicy = DEFAULT_RETENTION_POLICY,
  timestamp = Date.now(),
): {
  events: number;
  workflowEvents: number;
  workflows: number;
  runAttempts: number;
  settlements: number;
} {
  const result = database.transaction((transaction) => {
    const deletedWorkflowEvents = transaction
      .delete(workflowEvents)
      .where(and(
        lt(workflowEvents.createdAt, timestamp - policy.workflowEventMaxAgeMs),
        inArray(workflowEvents.workflowRunId, transaction
          .select({ runId: workflowRuns.runId })
          .from(workflowRuns)
          .where(ne(workflowRuns.status, "running"))),
      ))
      .run().changes;
    const workflows = transaction
      .delete(workflowRuns)
      .where(and(
        lt(workflowRuns.updatedAt, timestamp - policy.workflowRunMaxAgeMs),
        ne(workflowRuns.status, "running"),
        notExists(transaction
          .select({ runId: workflowExecutionClaims.workflowRunId })
          .from(workflowExecutionClaims)
          .where(and(
            eq(workflowExecutionClaims.workflowRunId, workflowRuns.runId),
            eq(workflowExecutionClaims.status, "running"),
          ))),
      ))
      .run().changes;
    const runAttempts = transaction
      .delete(sessionRunAttempts)
      .where(and(
        lt(sessionRunAttempts.updatedAt, timestamp - policy.runAttemptMaxAgeMs),
        notInArray(sessionRunAttempts.status, ["pending", "running"]),
      ))
      .run().changes;
    const settlements = transaction
      .delete(projectionSettlements)
      .where(and(
        lt(projectionSettlements.updatedAt, timestamp - policy.projectionSettlementMaxAgeMs),
        inArray(projectionSettlements.status, ["resolved", "abandoned"]),
      ))
      .run().changes;
    const removableEvents = transaction
      .select({ id: sessionEvents.id })
      .from(sessionEvents)
      .leftJoin(sessions, eq(sessions.id, sessionEvents.sessionId))
      .where(and(
        lt(sessionEvents.createdAt, timestamp - policy.durableEventMaxAgeMs),
        isNotNull(sessionEvents.sessionId),
        eq(sessions.status, "archived"),
        notExists(transaction
          .select({ sessionId: sessionRuns.sessionId })
          .from(sessionRuns)
          .where(and(
            eq(sessionRuns.sessionId, sessionEvents.sessionId),
            inArray(sessionRuns.status, ["pending", "running"]),
          ))),
      ))
      .all();
    if (removableEvents.length > 0) {
      const remove = transaction.delete(sessionEvents).where(eq(sessionEvents.id, placeholder("id"))).prepare();
      for (const event of removableEvents) {
        if (event.id !== null) remove.run({ id: event.id });
      }
    }
    const retentionResult = {
      events: removableEvents.length,
      workflowEvents: deletedWorkflowEvents,
      workflows,
      runAttempts,
      settlements,
    };
    transaction
      .insert(retentionAudits)
      .values({
        id: randomUUID(),
        policy: JSON.stringify(policy),
        resultJson: JSON.stringify(retentionResult),
        createdAt: timestamp,
      })
      .run();
    return retentionResult;
  });
  if (result.events > 0) {
    const removed = new Set(
      database.select({ id: sessionEvents.id }).from(sessionEvents).all().map((row) => row.id),
    );
    state.events = state.events.filter((event) =>
      removed.has(event.id),
    );
  }
  return result;
}

export function listRetentionAudits(database: SessionDatabase["orm"]): Array<Record<string, unknown>> {
  return database
    .select({
      id: retentionAudits.id,
      policy: retentionAudits.policy,
      result_json: retentionAudits.resultJson,
      created_at: retentionAudits.createdAt,
    })
    .from(retentionAudits)
    .orderBy(desc(retentionAudits.createdAt))
    .all();
}

export function recordRetentionAudit(database: SessionDatabase["orm"], input: {
  policy: string;
  result: unknown;
  timestamp?: number;
}): void {
  database
    .insert(retentionAudits)
    .values({
      id: randomUUID(),
      policy: input.policy,
      resultJson: JSON.stringify(input.result),
      createdAt: input.timestamp ?? now(),
    })
    .run();
}

export function latestRetentionAudit(database: SessionDatabase["orm"], policy: string):
  | {
      id: string;
      policy: string;
      result: unknown;
      createdAt: number;
    }
  | undefined {
  const row = database
    .select()
    .from(retentionAudits)
    .where(eq(retentionAudits.policy, policy))
    .orderBy(desc(retentionAudits.createdAt), desc(sql`${retentionAudits}.rowid`))
    .limit(1)
    .get();
  return row
    ? {
        id: row.id,
        policy: row.policy,
        result: JSON.parse(row.resultJson) as unknown,
        createdAt: row.createdAt,
      }
    : undefined;
}

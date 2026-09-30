import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
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
  database: Database.Database,
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
  const result = database.transaction(() => {
    const workflowEvents = database
      .prepare(
        `
      DELETE FROM workflow_event
      WHERE created_at < ? AND workflow_run_id IN (
        SELECT run_id FROM workflow_run WHERE status != 'running'
      )
    `,
      )
      .run(timestamp - policy.workflowEventMaxAgeMs).changes;
    const workflows = database
      .prepare(
        `
      DELETE FROM workflow_run
      WHERE updated_at < ? AND status != 'running'
        AND NOT EXISTS (
          SELECT 1 FROM workflow_execution_claim c
          WHERE c.workflow_run_id = workflow_run.run_id AND c.status = 'running'
        )
    `,
      )
      .run(timestamp - policy.workflowRunMaxAgeMs).changes;
    const runAttempts = database
      .prepare(
        `
      DELETE FROM session_run_attempt
      WHERE updated_at < ? AND status NOT IN ('pending', 'running')
    `,
      )
      .run(timestamp - policy.runAttemptMaxAgeMs).changes;
    const settlements = database
      .prepare(
        `
      DELETE FROM projection_settlement
      WHERE updated_at < ? AND status IN ('resolved', 'abandoned')
    `,
      )
      .run(timestamp - policy.projectionSettlementMaxAgeMs).changes;
    const removableEvents = database
      .prepare(
        `
      SELECT e.id FROM session_event e
      LEFT JOIN session s ON s.id = e.session_id
      WHERE e.created_at < ?
        AND e.session_id IS NOT NULL
        AND s.status = 'archived'
        AND NOT EXISTS (
          SELECT 1 FROM session_run r
          WHERE r.session_id = e.session_id AND r.status IN ('pending', 'running')
        )
    `,
      )
      .all(timestamp - policy.durableEventMaxAgeMs) as Array<{ id: string }>;
    if (removableEvents.length > 0) {
      const remove = database.prepare(
        "DELETE FROM session_event WHERE id = ?",
      );
      for (const event of removableEvents) remove.run(event.id);
    }
    const retentionResult = {
      events: removableEvents.length,
      workflowEvents,
      workflows,
      runAttempts,
      settlements,
    };
    database
      .prepare(
        `
      INSERT INTO retention_audit (id, policy, result_json, created_at)
      VALUES (?, ?, ?, ?)
    `,
      )
      .run(
        randomUUID(),
        JSON.stringify(policy),
        JSON.stringify(retentionResult),
        timestamp,
      );
    return retentionResult;
  })();
  if (result.events > 0) {
    const removed = new Set(
      (
        database.prepare("SELECT id FROM session_event").all() as Array<{
          id: string;
        }>
      ).map((row) => row.id),
    );
    state.events = state.events.filter((event) =>
      removed.has(event.id),
    );
  }
  return result;
}

export function listRetentionAudits(database: Database.Database): Array<Record<string, unknown>> {
  return database
    .prepare("SELECT * FROM retention_audit ORDER BY created_at DESC")
    .all() as Array<Record<string, unknown>>;
}

export function recordRetentionAudit(database: Database.Database, input: {
  policy: string;
  result: unknown;
  timestamp?: number;
}): void {
  database
    .prepare(
      `INSERT INTO retention_audit (id, policy, result_json, created_at)
     VALUES (?, ?, ?, ?)`,
    )
    .run(
      randomUUID(),
      input.policy,
      JSON.stringify(input.result),
      input.timestamp ?? now(),
    );
}

export function latestRetentionAudit(database: Database.Database, policy: string):
  | {
      id: string;
      policy: string;
      result: unknown;
      createdAt: number;
    }
  | undefined {
  const row = database
    .prepare(
      `SELECT id, policy, result_json, created_at
     FROM retention_audit
     WHERE policy = ?
     ORDER BY created_at DESC, rowid DESC
     LIMIT 1`,
    )
    .get(policy) as
    | {
        id: string;
        policy: string;
        result_json: string;
        created_at: number;
      }
    | undefined;
  return row
    ? {
        id: row.id,
        policy: row.policy,
        result: JSON.parse(row.result_json) as unknown,
        createdAt: row.created_at,
      }
    : undefined;
}

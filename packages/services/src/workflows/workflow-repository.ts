import type { StorageContext } from "../database/storage-context.js";
import {
  storedWorkflowRunFromRow,
  type StoredWorkflowRunInput,
  type StoredWorkflowRunRecord,
  type StoredWorkflowEventInput,
  type WorkflowRunClaim,
} from "./workflow-records.js";

export class WorkflowRepository {
  constructor(private readonly storage: StorageContext) {}

  saveRun(input: StoredWorkflowRunInput): void {
    this.storage.assertWritable();
    const database = this.storage.database.connection;
    database.transaction(() => {
      database
        .prepare(
          `INSERT INTO workflow_run
            (run_id, owner_session_id, owner_input_id, owner_run_id, status,
             termination, snapshot_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(run_id) DO UPDATE SET
             owner_session_id = excluded.owner_session_id,
             owner_input_id = excluded.owner_input_id,
             owner_run_id = excluded.owner_run_id,
             status = excluded.status,
             termination = excluded.termination,
             snapshot_json = excluded.snapshot_json,
             updated_at = excluded.updated_at`,
        )
        .run(
          input.runId,
          input.ownerSessionId ?? null,
          input.ownerInputId ?? null,
          input.ownerRunId ?? null,
          input.status,
          input.termination ?? null,
          input.snapshotJson,
          input.createdAt,
          input.updatedAt,
        );
      database
        .prepare("DELETE FROM workflow_task_attempt WHERE workflow_run_id = ?")
        .run(input.runId);
      const insert = database.prepare(
        `INSERT INTO workflow_task_attempt
          (workflow_run_id, task_id, attempt, status, payload_json, started_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const attempt of input.taskAttempts) {
        insert.run(
          input.runId,
          attempt.taskId,
          attempt.attempt,
          attempt.status,
          attempt.payloadJson,
          attempt.startedAt,
          attempt.finishedAt ?? null,
        );
      }
    })();
  }

  loadRun(runId: string): StoredWorkflowRunRecord | undefined {
    const row = this.storage.database.connection
      .prepare("SELECT * FROM workflow_run WHERE run_id = ?")
      .get(runId) as Record<string, unknown> | undefined;
    return row ? storedWorkflowRunFromRow(row) : undefined;
  }

  listRuns(
    options: { ownerSessionId?: string; status?: string } = {},
  ): StoredWorkflowRunRecord[] {
    const clauses: string[] = [];
    const parameters: unknown[] = [];
    if (options.ownerSessionId) {
      clauses.push("owner_session_id = ?");
      parameters.push(options.ownerSessionId);
    }
    if (options.status) {
      clauses.push("status = ?");
      parameters.push(options.status);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return (
      this.storage.database.connection
        .prepare(`SELECT * FROM workflow_run ${where} ORDER BY updated_at DESC`)
        .all(...parameters) as Array<Record<string, unknown>>
    ).map(storedWorkflowRunFromRow);
  }

  appendEvent(input: StoredWorkflowEventInput): number {
    this.storage.assertWritable();
    const result = this.storage.database.connection
      .prepare(
        "INSERT INTO workflow_event (workflow_run_id, type, event_json, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(input.runId, input.type, input.eventJson, input.createdAt);
    return Number(result.lastInsertRowid);
  }

  listEvents(runId: string): string[] {
    return (
      this.storage.database.connection
        .prepare(
          "SELECT event_json FROM workflow_event WHERE workflow_run_id = ? ORDER BY seq",
        )
        .all(runId) as Array<{ event_json: string }>
    ).map((row) => row.event_json);
  }

  claimRun(runId: string, ownerId: string): WorkflowRunClaim {
    this.storage.assertWritable();
    const database = this.storage.database.connection;
    return database.transaction(() => {
      const current = database
        .prepare(
          "SELECT owner_id, generation, status FROM workflow_execution_claim WHERE workflow_run_id = ?",
        )
        .get(runId) as
        | { owner_id: string; generation: number; status: string }
        | undefined;
      if (current?.status === "running" && current.owner_id === ownerId) {
        throw new Error(
          `Workflow run is already claimed by this Application: ${runId}`,
        );
      }
      const generation = (current?.generation ?? 0) + 1;
      const claimedAt = Date.now();
      database
        .prepare(
          `INSERT INTO workflow_execution_claim
            (workflow_run_id, owner_id, generation, claimed_at, heartbeat_at, finished_at, status)
           VALUES (?, ?, ?, ?, ?, NULL, 'running')
           ON CONFLICT(workflow_run_id) DO UPDATE SET
             owner_id = excluded.owner_id, generation = excluded.generation,
             claimed_at = excluded.claimed_at, heartbeat_at = excluded.heartbeat_at,
             finished_at = NULL, status = 'running'`,
        )
        .run(runId, ownerId, generation, claimedAt, claimedAt);
      return { ownerId, generation, claimedAt };
    })();
  }

  finishClaim(runId: string, ownerId: string, status: string): void {
    this.storage.assertWritable();
    const timestamp = Date.now();
    const result = this.storage.database.connection
      .prepare(
        `UPDATE workflow_execution_claim SET status = ?, finished_at = ?, heartbeat_at = ?
         WHERE workflow_run_id = ? AND owner_id = ? AND status = 'running'`,
      )
      .run(status, timestamp, timestamp, runId, ownerId);
    if (result.changes !== 1) {
      throw new Error(
        `Workflow run claim is not active for this Application: ${runId}`,
      );
    }
  }
}

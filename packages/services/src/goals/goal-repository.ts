import { randomUUID } from "node:crypto";

import type { SessionGoal } from "@openharness/protocol";

import type { StorageContext } from "../database/storage-context.js";
import {
  goalRequestFromRow,
  sessionGoalFromRow,
  type CreateSessionGoalStoreInput,
  type SessionGoalRequestRecord,
  type UpdateSessionGoalStoreInput,
} from "./goal-records.js";

export class GoalRepository {
  constructor(private readonly storage: StorageContext) {}

  private get database() {
    return this.storage.database.connection;
  }

  getGoal(id: string): SessionGoal | undefined {
    const row = this.database
      .prepare("SELECT * FROM session_goal WHERE id = ?")
      .get(id);
    return row ? sessionGoalFromRow(row as Record<string, unknown>) : undefined;
  }

  getCurrentGoal(sessionId: string): SessionGoal | undefined {
    const row = this.database
      .prepare(
        `SELECT * FROM session_goal
      WHERE session_id = ?
      ORDER BY CASE WHEN status IN ('active','waiting_user','blocked','paused') THEN 0 ELSE 1 END,
               updated_at DESC
      LIMIT 1`,
      )
      .get(sessionId);
    return row ? sessionGoalFromRow(row as Record<string, unknown>) : undefined;
  }

  insertGoal(input: CreateSessionGoalStoreInput): SessionGoal {
    const id = input.id ?? randomUUID();
    const timestamp = Date.now();
    try {
      this.database
        .prepare(
          `INSERT INTO session_goal (
        id, session_id, objective, plugin_id, revision, status, max_auto_turns,
        auto_turns_used, no_progress_count, evidence_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 0, 'active', ?, 0, 0, '[]', ?, ?)`,
        )
        .run(
          id,
          input.sessionId,
          input.objective,
          input.pluginId ?? null,
          input.maxAutoTurns,
          timestamp,
          timestamp,
        );
    } catch (error) {
      if (String(error).includes("session_goal_session_open_unique")) {
        throw new Error(`Session already has an open goal: ${input.sessionId}`);
      }
      throw error;
    }
    return this.getGoal(id)!;
  }

  updateGoalRevision(
    id: string,
    input: UpdateSessionGoalStoreInput,
  ): SessionGoal {
    const current = this.getGoal(id);
    if (!current) throw new Error(`Session goal not found: ${id}`);
    if (current.revision !== input.expectedRevision)
      throw new Error("session_goal_revision_conflict");
    const next = {
      objective: input.objective ?? current.objective,
      pluginId: input.pluginId ?? current.pluginId,
      status: input.status ?? current.status,
      maxAutoTurns: input.maxAutoTurns ?? current.maxAutoTurns,
      autoTurnsUsed: input.autoTurnsUsed ?? current.autoTurnsUsed,
      noProgressCount: input.noProgressCount ?? current.noProgressCount,
      blockerKey:
        input.blockerKey === undefined
          ? current.blockerKey
          : (input.blockerKey ?? undefined),
      currentRunId:
        input.currentRunId === undefined
          ? current.currentRunId
          : (input.currentRunId ?? undefined),
      reason:
        input.reason === undefined
          ? current.reason
          : (input.reason ?? undefined),
      wait: input.wait === undefined ? current.wait : (input.wait ?? undefined),
      evidence: input.evidence ?? current.evidence,
      assessment:
        input.assessment === undefined
          ? current.assessment
          : (input.assessment ?? undefined),
    };
    const result = this.database
      .prepare(
        `UPDATE session_goal SET objective = ?, plugin_id = ?, revision = ?, status = ?, max_auto_turns = ?,
      auto_turns_used = ?, no_progress_count = ?, blocker_key = ?, current_run_id = ?, reason = ?, wait_json = ?, evidence_json = ?, last_assessment_json = ?, updated_at = ?
      WHERE id = ? AND revision = ?`,
      )
      .run(
        next.objective,
        next.pluginId ?? null,
        current.revision + 1,
        next.status,
        next.maxAutoTurns,
        next.autoTurnsUsed,
        next.noProgressCount,
        next.blockerKey ?? null,
        next.currentRunId ?? null,
        next.reason ?? null,
        next.wait ? JSON.stringify(next.wait) : null,
        JSON.stringify(next.evidence),
        next.assessment ? JSON.stringify(next.assessment) : null,
        Date.now(),
        id,
        input.expectedRevision,
      );
    if (result.changes !== 1) throw new Error("session_goal_revision_conflict");
    return this.getGoal(id)!;
  }

  getRequest(requestId: string): SessionGoalRequestRecord | undefined {
    const row = this.database
      .prepare("SELECT * FROM session_goal_request WHERE request_id = ?")
      .get(requestId) as Record<string, unknown> | undefined;
    return row ? goalRequestFromRow(row) : undefined;
  }

  beginRequest(input: {
    requestId: string;
    sessionId: string;
    fingerprint: string;
  }): SessionGoalRequestRecord {
    const existing = this.getRequest(input.requestId);
    if (existing) {
      if (
        existing.sessionId !== input.sessionId ||
        existing.fingerprint !== input.fingerprint
      )
        throw new Error("session_goal_request_conflict");
      return existing;
    }
    const timestamp = Date.now();
    this.database
      .prepare(
        "INSERT INTO session_goal_request (request_id, session_id, fingerprint, status, created_at, updated_at) VALUES (?, ?, ?, 'pending', ?, ?)",
      )
      .run(
        input.requestId,
        input.sessionId,
        input.fingerprint,
        timestamp,
        timestamp,
      );
    return this.getRequest(input.requestId)!;
  }

  settleRequest(
    requestId: string,
    input: {
      status: "pending" | "completed" | "failed";
      goalId?: string;
      result?: Record<string, unknown>;
      error?: string;
    },
  ): SessionGoalRequestRecord {
    const result = this.database
      .prepare(
        "UPDATE session_goal_request SET status = ?, goal_id = ?, result_json = ?, error = ?, updated_at = ? WHERE request_id = ?",
      )
      .run(
        input.status,
        input.goalId ?? null,
        input.result ? JSON.stringify(input.result) : null,
        input.error ?? null,
        Date.now(),
        requestId,
      );
    if (result.changes !== 1)
      throw new Error(`Session goal request not found: ${requestId}`);
    return this.getRequest(requestId)!;
  }

  recordAssessment(input: {
    goalId: string;
    revision: number;
    runId: string;
    assessment: Record<string, unknown>;
  }): void {
    this.database
      .prepare(
        `INSERT INTO session_goal_assessment (id, goal_id, revision, run_id, assessment_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(goal_id, revision, run_id) DO UPDATE SET assessment_json = excluded.assessment_json`,
      )
      .run(
        randomUUID(),
        input.goalId,
        input.revision,
        input.runId,
        JSON.stringify(input.assessment),
        Date.now(),
      );
  }

  evidenceSignatures(goalId: string): string[] {
    const rows = this.database
      .prepare(
        "SELECT assessment_json FROM session_goal_assessment WHERE goal_id = ?",
      )
      .all(goalId) as { assessment_json: string }[];
    return rows.flatMap(
      (row) =>
        (JSON.parse(row.assessment_json) as { verifiedSignatures?: string[] })
          .verifiedSignatures ?? [],
    );
  }

  recordContinuation(input: {
    goalId: string;
    revision: number;
    previousRunId: string;
    inputId: string;
    runId: string;
  }): boolean {
    const timestamp = Date.now();
    return (
      this.database
        .prepare(
          `INSERT OR IGNORE INTO session_goal_continuation
      (id, goal_id, revision, previous_run_id, input_id, run_id, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        )
        .run(
          randomUUID(),
          input.goalId,
          input.revision,
          input.previousRunId,
          input.inputId,
          input.runId,
          timestamp,
          timestamp,
        ).changes === 1
    );
  }

  markContinuation(runId: string, status: "dispatched" | "cancelled"): void {
    this.database
      .prepare(
        "UPDATE session_goal_continuation SET status = ?, updated_at = ? WHERE run_id = ?",
      )
      .run(status, Date.now(), runId);
  }

  listActiveGoalIds(): string[] {
    return (
      this.database
        .prepare("SELECT id FROM session_goal WHERE status = 'active'")
        .all() as { id: string }[]
    ).map((row) => row.id);
  }

  cancelPendingContinuations(): void {
    this.database
      .prepare(
        "UPDATE session_goal_continuation SET status = 'cancelled', updated_at = ? WHERE status = 'pending'",
      )
      .run(Date.now());
  }

  findGoalIdByCurrentRun(runId: string): string | undefined {
    return (
      this.database
        .prepare("SELECT id FROM session_goal WHERE current_run_id = ?")
        .get(runId) as { id?: string } | undefined
    )?.id;
  }

  clearCurrentRun(id: string): void {
    this.database
      .prepare(
        "UPDATE session_goal SET current_run_id = NULL, updated_at = ? WHERE id = ?",
      )
      .run(Date.now(), id);
  }

  bindCurrentRun(
    goalId: string,
    revision: number,
    runId: string,
    automatic: boolean,
  ): void {
    this.database
      .prepare(
        "UPDATE session_goal SET current_run_id = ?, auto_turns_used = auto_turns_used + ?, updated_at = ? WHERE id = ? AND revision = ?",
      )
      .run(runId, automatic ? 1 : 0, Date.now(), goalId, revision);
  }
}

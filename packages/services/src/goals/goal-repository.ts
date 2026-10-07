import { randomUUID } from "node:crypto";

import type { SessionGoal } from "@vykor/protocol";
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";

import type { StorageContext } from "../database/storage-context.js";
import {
  sessionGoalAssessments,
  sessionGoalContinuations,
  sessionGoalRequests,
  sessionGoals,
} from "../session-runtime/schema.js";
import {
  goalRequestFromRow,
  sessionGoalFromRow,
  type CreateSessionGoalStoreInput,
  type SessionGoalRequestRecord,
  type UpdateSessionGoalStoreInput,
} from "./goal-records.js";

const openGoalStatuses = new Set(["active", "waiting_user", "blocked", "paused"]);

export class GoalRepository {
  constructor(private readonly storage: StorageContext) {}

  private get database() {
    return this.storage.database.orm;
  }

  private get temporary() {
    return this.storage.temporaryControls;
  }

  private isTemporary(sessionId: string): boolean {
    return this.storage.state.sessions[sessionId]?.storage === "memory";
  }

  private temporaryRecords() {
    if (!this.temporary) {
      throw new Error("Temporary control records not initialized");
    }
    return this.temporary;
  }

  getGoal(id: string): SessionGoal | undefined {
    const row = this.temporary?.goals.get(id) ?? this.database
      .select()
      .from(sessionGoals)
      .where(eq(sessionGoals.id, id))
      .get();
    return row ? sessionGoalFromRow(row) : undefined;
  }

  getCurrentGoal(sessionId: string): SessionGoal | undefined {
    const row = this.isTemporary(sessionId)
      ? [...this.temporaryRecords().goals.values()]
        .filter((row) =>
          row.sessionId === sessionId && openGoalStatuses.has(row.status),
        )
        .sort((left, right) => right.updatedAt - left.updatedAt)[0]
      : this.database
      .select()
      .from(sessionGoals)
      .where(
        and(
          eq(sessionGoals.sessionId, sessionId),
          inArray(sessionGoals.status, [...openGoalStatuses]),
        ),
      )
      .orderBy(desc(sessionGoals.updatedAt))
      .limit(1)
      .get();
    return row ? sessionGoalFromRow(row) : undefined;
  }

  insertGoal(input: CreateSessionGoalStoreInput): SessionGoal {
    const id = input.id ?? randomUUID();
    const timestamp = Date.now();
    const row: typeof sessionGoals.$inferSelect = {
      id,
      sessionId: input.sessionId,
      objective: input.objective,
      pluginId: input.pluginId ?? null,
      revision: 0,
      status: "active",
      maxAutoTurns: input.maxAutoTurns,
      autoTurnsUsed: 0,
      noProgressCount: 0,
      blockerKey: null,
      lastAssessmentJson: null,
      currentRunId: null,
      reason: null,
      waitJson: null,
      evidenceJson: "[]",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    if (this.getGoal(id)) {
      throw new Error("UNIQUE constraint failed: session_goal.id");
    }
    if (this.isTemporary(input.sessionId)) {
      if (this.getCurrentGoal(input.sessionId)) {
        throw new Error(`Session already has an open goal: ${input.sessionId}`);
      }
      this.temporaryRecords().capture(this.temporaryRecords().goals, id);
      this.temporaryRecords().goals.set(id, row);
      return this.getGoal(id)!;
    }
    try {
      this.database
        .insert(sessionGoals)
        .values(row)
        .run();
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
    const changes = {
      objective: next.objective,
      pluginId: next.pluginId ?? null,
      revision: current.revision + 1,
      status: next.status,
      maxAutoTurns: next.maxAutoTurns,
      autoTurnsUsed: next.autoTurnsUsed,
      noProgressCount: next.noProgressCount,
      blockerKey: next.blockerKey ?? null,
      currentRunId: next.currentRunId ?? null,
      reason: next.reason ?? null,
      waitJson: next.wait ? JSON.stringify(next.wait) : null,
      evidenceJson: JSON.stringify(next.evidence),
      lastAssessmentJson: next.assessment ? JSON.stringify(next.assessment) : null,
      updatedAt: Date.now(),
    };
    const temporaryRow = this.temporary?.goals.get(id);
    if (temporaryRow) {
      const existingOpen = this.getCurrentGoal(current.sessionId);
      if (
        openGoalStatuses.has(changes.status) &&
        existingOpen && existingOpen.id !== id
      ) {
        throw new Error(`Session already has an open goal: ${current.sessionId}`);
      }
      this.temporaryRecords().capture(this.temporaryRecords().goals, id);
      this.temporaryRecords().goals.set(id, { ...temporaryRow, ...changes });
      return this.getGoal(id)!;
    }
    const result = this.database
      .update(sessionGoals)
      .set(changes)
      .where(
        and(
          eq(sessionGoals.id, id),
          eq(sessionGoals.revision, input.expectedRevision),
        ),
      )
      .run();
    if (result.changes !== 1) throw new Error("session_goal_revision_conflict");
    return this.getGoal(id)!;
  }

  getRequest(requestId: string): SessionGoalRequestRecord | undefined {
    const row = this.temporary?.requests.get(requestId) ?? this.database
      .select()
      .from(sessionGoalRequests)
      .where(eq(sessionGoalRequests.requestId, requestId))
      .get();
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
    const row: typeof sessionGoalRequests.$inferSelect = {
      requestId: input.requestId,
      sessionId: input.sessionId,
      fingerprint: input.fingerprint,
      status: "pending",
      goalId: null,
      resultJson: null,
      error: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    if (this.isTemporary(input.sessionId)) {
      this.temporaryRecords().capture(this.temporaryRecords().requests, input.requestId);
      this.temporaryRecords().requests.set(input.requestId, row);
      return this.getRequest(input.requestId)!;
    }
    this.database
      .insert(sessionGoalRequests)
      .values(row)
      .run();
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
    const changes = {
      status: input.status,
      goalId: input.goalId ?? null,
      resultJson: input.result ? JSON.stringify(input.result) : null,
      error: input.error ?? null,
      updatedAt: Date.now(),
    };
    const temporaryRow = this.temporary?.requests.get(requestId);
    if (temporaryRow) {
      this.temporaryRecords().capture(this.temporaryRecords().requests, requestId);
      this.temporaryRecords().requests.set(requestId, { ...temporaryRow, ...changes });
      return this.getRequest(requestId)!;
    }
    const result = this.database
      .update(sessionGoalRequests)
      .set(changes)
      .where(eq(sessionGoalRequests.requestId, requestId))
      .run();
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
    const assessmentJson = JSON.stringify(input.assessment);
    const row: typeof sessionGoalAssessments.$inferSelect = {
      id: randomUUID(),
      goalId: input.goalId,
      revision: input.revision,
      runId: input.runId,
      assessmentJson,
      createdAt: Date.now(),
    };
    if (this.temporary?.goals.has(input.goalId)) {
      const records = this.temporaryRecords();
      const existing = [...records.assessments.values()].find((row) =>
        row.goalId === input.goalId &&
        row.revision === input.revision && row.runId === input.runId,
      );
      records.capture(records.assessments, existing?.id ?? row.id);
      records.assessments.set(
        existing?.id ?? row.id,
        existing ? { ...existing, assessmentJson } : row,
      );
      return;
    }
    this.database
      .insert(sessionGoalAssessments)
      .values(row)
      .onConflictDoUpdate({
        target: [
          sessionGoalAssessments.goalId,
          sessionGoalAssessments.revision,
          sessionGoalAssessments.runId,
        ],
        set: { assessmentJson },
      })
      .run();
  }

  evidenceSignatures(goalId: string): string[] {
    const rows = this.temporary?.goals.has(goalId)
      ? [...this.temporaryRecords().assessments.values()]
        .filter((row) => row.goalId === goalId)
      : this.database
      .select({ assessmentJson: sessionGoalAssessments.assessmentJson })
      .from(sessionGoalAssessments)
      .where(eq(sessionGoalAssessments.goalId, goalId))
      .all();
    return rows.flatMap(
      (row) =>
        (JSON.parse(row.assessmentJson) as { verifiedSignatures?: string[] })
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
    const row: typeof sessionGoalContinuations.$inferSelect = {
      id: randomUUID(),
      goalId: input.goalId,
      revision: input.revision,
      previousRunId: input.previousRunId,
      inputId: input.inputId ?? null,
      runId: input.runId ?? null,
      status: "pending",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    if (this.temporary?.goals.has(input.goalId)) {
      if (Number.isNaN(input.revision) || input.revision == null || input.previousRunId == null) return false;
      const records = this.temporaryRecords();
      if ([...records.continuations.values()].some((row) =>
        row.goalId === input.goalId &&
        row.revision === input.revision && row.previousRunId === input.previousRunId,
      )) return false;
      records.capture(records.continuations, row.id);
      records.continuations.set(row.id, row);
      return true;
    }
    try {
      return this.database
        .insert(sessionGoalContinuations)
        .values(row)
        .onConflictDoNothing()
        .run().changes === 1;
    } catch (error) {
      // 保留原忽略约束违规的行为；外键、触发器等异常仍正常抛出。
      if (error instanceof Error && "code" in error && (
        error.code === "SQLITE_CONSTRAINT_NOTNULL" || error.code === "SQLITE_CONSTRAINT_CHECK"
      )) return false;
      throw error;
    }
  }

  markContinuation(runId: string, status: "dispatched" | "cancelled"): void {
    const records = this.temporary?.continuations;
    let updatedTemporary = false;
    for (const [id, row] of records ?? []) {
      if (row.runId === runId) {
        this.temporary!.capture(records!, id);
        records!.set(id, { ...row, status, updatedAt: Date.now() });
        updatedTemporary = true;
      }
    }
    if (updatedTemporary) return;
    this.database
      .update(sessionGoalContinuations)
      .set({ status, updatedAt: Date.now() })
      .where(eq(sessionGoalContinuations.runId, runId))
      .run();
  }

  listActiveGoalIds(): string[] {
    const stored = this.database
      .select({ id: sessionGoals.id })
      .from(sessionGoals)
      .where(eq(sessionGoals.status, "active"))
      .all()
      .map((row) => row.id);
    const temporary = [...this.temporary?.goals.values() ?? []]
      .filter((row) => row.status === "active")
      .map((row) => row.id);
    return [...stored, ...temporary];
  }

  listActiveExternalWaitGoals(): SessionGoal[] {
    const stored = this.database
      .select()
      .from(sessionGoals)
      .where(
        and(eq(sessionGoals.status, "active"), isNotNull(sessionGoals.waitJson)),
      )
      .all();
    const temporary = [...this.temporary?.goals.values() ?? []]
      .filter((row) => row.status === "active" && row.waitJson !== null);
    return [...stored, ...temporary]
      .map(sessionGoalFromRow)
      .filter((goal) => goal.wait?.kind === "external");
  }

  cancelPendingContinuations(): void {
    const records = this.temporary?.continuations;
    for (const [id, row] of records ?? []) {
      if (row.status === "pending") {
        this.temporary!.capture(records!, id);
        records!.set(id, { ...row, status: "cancelled", updatedAt: Date.now() });
      }
    }
    this.database
      .update(sessionGoalContinuations)
      .set({ status: "cancelled", updatedAt: Date.now() })
      .where(eq(sessionGoalContinuations.status, "pending"))
      .run();
  }

  findGoalIdByCurrentRun(runId: string): string | undefined {
    const temporary = [...this.temporary?.goals.values() ?? []]
      .find((row) => row.currentRunId === runId);
    return temporary?.id ?? this.database
      .select({ id: sessionGoals.id })
      .from(sessionGoals)
      .where(eq(sessionGoals.currentRunId, runId))
      .get()?.id;
  }

  clearCurrentRun(id: string): void {
    const temporaryRow = this.temporary?.goals.get(id);
    if (temporaryRow) {
      this.temporary!.capture(this.temporary!.goals, id);
      this.temporary!.goals.set(id, { ...temporaryRow, currentRunId: null, updatedAt: Date.now() });
      return;
    }
    this.database
      .update(sessionGoals)
      .set({ currentRunId: null, updatedAt: Date.now() })
      .where(eq(sessionGoals.id, id))
      .run();
  }

  bindCurrentRun(
    goalId: string,
    revision: number,
    runId: string,
    automatic: boolean,
  ): void {
    const temporaryRow = this.temporary?.goals.get(goalId);
    if (temporaryRow) {
      if (temporaryRow.revision === revision) {
        this.temporary!.capture(this.temporary!.goals, goalId);
        this.temporary!.goals.set(goalId, {
          ...temporaryRow,
          currentRunId: runId,
          autoTurnsUsed: temporaryRow.autoTurnsUsed + (automatic ? 1 : 0),
          updatedAt: Date.now(),
        });
      }
      return;
    }
    this.database
      .update(sessionGoals)
      .set({
        currentRunId: runId,
        autoTurnsUsed: sql`${sessionGoals.autoTurnsUsed} + ${automatic ? 1 : 0}`,
        updatedAt: Date.now(),
      })
      .where(and(eq(sessionGoals.id, goalId), eq(sessionGoals.revision, revision)))
      .run();
  }
}

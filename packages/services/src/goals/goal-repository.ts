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

export class GoalRepository {
  constructor(private readonly storage: StorageContext) {}

  private get database() {
    return this.storage.database.orm;
  }

  getGoal(id: string): SessionGoal | undefined {
    const row = this.database
      .select()
      .from(sessionGoals)
      .where(eq(sessionGoals.id, id))
      .get();
    return row ? sessionGoalFromRow(row) : undefined;
  }

  getCurrentGoal(sessionId: string): SessionGoal | undefined {
    const row = this.database
      .select()
      .from(sessionGoals)
      .where(
        and(
          eq(sessionGoals.sessionId, sessionId),
          inArray(sessionGoals.status, [
            "active",
            "waiting_user",
            "blocked",
            "paused",
          ]),
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
    try {
      this.database
        .insert(sessionGoals)
        .values({
          id,
          sessionId: input.sessionId,
          objective: input.objective,
          pluginId: input.pluginId ?? null,
          revision: 0,
          status: "active",
          maxAutoTurns: input.maxAutoTurns,
          autoTurnsUsed: 0,
          noProgressCount: 0,
          evidenceJson: "[]",
          createdAt: timestamp,
          updatedAt: timestamp,
        })
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
    const result = this.database
      .update(sessionGoals)
      .set({
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
      })
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
    const row = this.database
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
    this.database
      .insert(sessionGoalRequests)
      .values({
        requestId: input.requestId,
        sessionId: input.sessionId,
        fingerprint: input.fingerprint,
        status: "pending",
        createdAt: timestamp,
        updatedAt: timestamp,
      })
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
    const result = this.database
      .update(sessionGoalRequests)
      .set({
        status: input.status,
        goalId: input.goalId ?? null,
        resultJson: input.result ? JSON.stringify(input.result) : null,
        error: input.error ?? null,
        updatedAt: Date.now(),
      })
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
    this.database
      .insert(sessionGoalAssessments)
      .values({
        id: randomUUID(),
        goalId: input.goalId,
        revision: input.revision,
        runId: input.runId,
        assessmentJson,
        createdAt: Date.now(),
      })
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
    const rows = this.database
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
    try {
      return this.database
        .insert(sessionGoalContinuations)
        .values({
          id: randomUUID(),
          goalId: input.goalId,
          revision: input.revision,
          previousRunId: input.previousRunId,
          inputId: input.inputId,
          runId: input.runId,
          status: "pending",
          createdAt: timestamp,
          updatedAt: timestamp,
        })
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
    this.database
      .update(sessionGoalContinuations)
      .set({ status, updatedAt: Date.now() })
      .where(eq(sessionGoalContinuations.runId, runId))
      .run();
  }

  listActiveGoalIds(): string[] {
    return this.database
      .select({ id: sessionGoals.id })
      .from(sessionGoals)
      .where(eq(sessionGoals.status, "active"))
      .all()
      .map((row) => row.id);
  }

  listActiveExternalWaitGoals(): SessionGoal[] {
    return this.database
      .select()
      .from(sessionGoals)
      .where(
        and(eq(sessionGoals.status, "active"), isNotNull(sessionGoals.waitJson)),
      )
      .all()
      .map(sessionGoalFromRow)
      .filter((goal) => goal.wait?.kind === "external");
  }

  cancelPendingContinuations(): void {
    this.database
      .update(sessionGoalContinuations)
      .set({ status: "cancelled", updatedAt: Date.now() })
      .where(eq(sessionGoalContinuations.status, "pending"))
      .run();
  }

  findGoalIdByCurrentRun(runId: string): string | undefined {
    return this.database
      .select({ id: sessionGoals.id })
      .from(sessionGoals)
      .where(eq(sessionGoals.currentRunId, runId))
      .get()?.id;
  }

  clearCurrentRun(id: string): void {
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

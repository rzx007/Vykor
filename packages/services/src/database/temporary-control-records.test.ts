import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { GoalRepository } from "../goals/goal-repository.js";
import {
  abandonProjectionSettlement,
  createProjectionSettlement,
  failProjectionSettlement,
  getProjectionSettlement,
  listProjectionSettlements,
  markProjectionSettlementRetrying,
  resolveProjectionSettlement,
} from "../session-runtime/projection-settlements.js";
import { SessionStore } from "../session-runtime/store.js";
import type { StorageContext } from "./storage-context.js";
import { TemporaryControlRecords } from "./temporary-control-records.js";

function withTemporaryRepository(
  test: (repository: GoalRepository, storage: StorageContext, store: SessionStore) => void,
): void {
  const directory = mkdtempSync(join(tmpdir(), "vk-temporary-controls-"));
  const store = new SessionStore({ path: join(directory, "sessions.db") });
  try {
    const formal = store.sessions.create({ id: "formal", cwd: process.cwd(), model: "m" });
    const storage = (store as unknown as { storage: StorageContext }).storage;
    storage.temporaryControls ??= new TemporaryControlRecords();
    storage.state.sessions.temporary = { ...formal, id: "temporary", storage: "memory" };
    test(new GoalRepository(storage), storage, store);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

const settlementInput = {
  id: "temporary-settlement",
  projector: "execution",
  rootSessionId: "temporary",
  eventSequence: 2,
  action: "retry-terminal-projection" as const,
  payload: { taskId: "task-1" },
};

describe("temporary control records", () => {
  it("routes the public goal and settlement operations by the actual session storage", () => {
    const directory = mkdtempSync(join(tmpdir(), "vk-temporary-control-integration-"));
    const path = join(directory, "sessions.db");
    const store = new SessionStore({ path });
    try {
      store.sessions.create({ id: "formal", cwd: process.cwd(), model: "m" });
      store.sessions.create({ id: "temporary", cwd: process.cwd(), model: "m", storage: "memory" });
      const formalGoal = store.goals.createGoal({ id: "formal-goal", sessionId: "formal", objective: "formal", maxAutoTurns: 1 });
      const goal = store.goals.createGoal({ id: "temporary-goal", sessionId: "temporary", objective: "finish", maxAutoTurns: 2 });
      const run = store.runs.createRun({ id: "temporary-run", sessionId: "temporary" });
      expect(store.goals.startGoalRun(goal.id, 0, run.id, true)).toBe(true);
      expect(store.goals.getGoal(goal.id)).toMatchObject({ currentRunId: run.id, autoTurnsUsed: 1 });
      store.goals.finishGoalRun(run.id);
      expect(store.goals.getGoal(goal.id)?.currentRunId).toBeUndefined();
      store.goals.beginGoalRequest({ requestId: "temporary-request", sessionId: "temporary", fingerprint: "same" });
      store.goals.recordGoalAssessment({ goalId: goal.id, revision: 0, runId: run.id, assessment: { verifiedSignatures: ["saved"] } });
      expect(store.goals.recordGoalContinuation({ goalId: goal.id, revision: 0, previousRunId: run.id, inputId: "next-input", runId: "next-run" })).toBe(true);
      const settlement = store.createProjectionSettlement(settlementInput);
      expect(store.markProjectionSettlementRetrying(settlement.id)).toMatchObject({ status: "retrying", attemptCount: 1 });
      const storage = (store as unknown as { storage: StorageContext }).storage;
      expect(storage.database.connection.prepare("SELECT id FROM session_goal").all()).toEqual([{ id: formalGoal.id }]);
      for (const table of ["session_goal_request", "session_goal_assessment", "session_goal_continuation", "projection_settlement"]) {
        expect(storage.database.connection.prepare(`SELECT count(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
      }
      store.close();
      const reopened = new SessionStore({ path });
      try {
        expect(reopened.goals.getGoal(formalGoal.id)?.objective).toBe("formal");
        expect(reopened.goals.getGoal(goal.id)).toBeUndefined();
        expect(reopened.goals.getGoalRequest("temporary-request")).toBeUndefined();
        expect(reopened.goals.goalEvidenceSignatures(goal.id)).toEqual([]);
        expect(reopened.getProjectionSettlement(settlement.id)).toBeUndefined();
      } finally {
        reopened.close();
      }
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps a temporary goal and its request out of SQLite", () => {
    const directory = mkdtempSync(join(tmpdir(), "vk-temporary-controls-"));
    const path = join(directory, "sessions.db");
    const store = new SessionStore({ path });
    try {
      const formal = store.sessions.create({ id: "formal", cwd: process.cwd(), model: "m" });
      const storage = (store as any).storage;
      storage.temporaryControls ??= new TemporaryControlRecords();
      storage.state.sessions.temporary = { ...formal, id: "temporary", storage: "memory" };
      const repository = new GoalRepository(storage);

      const goal = repository.insertGoal({ id: "temporary-goal", sessionId: "temporary", objective: "finish", maxAutoTurns: 2 });
      expect(goal).toMatchObject({ id: "temporary-goal", sessionId: "temporary", revision: 0 });
      repository.beginRequest({ requestId: "temporary-request", sessionId: "temporary", fingerprint: "same" });
      repository.settleRequest("temporary-request", { status: "completed", goalId: goal.id, result: { runId: "run" } });
      expect(repository.getRequest("temporary-request")).toMatchObject({ status: "completed", result: { runId: "run" } });
      expect(storage.database.connection.prepare("SELECT count(*) AS count FROM session_goal").get()).toEqual({ count: 0 });
      expect(storage.database.connection.prepare("SELECT count(*) AS count FROM session_goal_request").get()).toEqual({ count: 0 });
      store.close();
      const reopened = new SessionStore({ path });
      try {
        expect(reopened.goals.getGoal(goal.id)).toBeUndefined();
        expect(reopened.goals.getGoalRequest("temporary-request")).toBeUndefined();
      } finally {
        reopened.close();
      }
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps temporary projection settlements out of SQLite", () => {
    const directory = mkdtempSync(join(tmpdir(), "vk-temporary-settlements-"));
    const store = new SessionStore({ path: join(directory, "sessions.db") });
    try {
      const storage = (store as any).storage;
      storage.temporaryControls ??= new TemporaryControlRecords();
      const settlement = createProjectionSettlement(storage.database.orm, {
        id: "temporary-settlement",
        projector: "execution",
        rootSessionId: "temporary",
        eventSequence: 2,
        action: "retry-terminal-projection",
        payload: { taskId: "task-1" },
      }, storage.temporaryControls, "memory");
      expect(settlement).toMatchObject({ id: "temporary-settlement", status: "pending" });
      expect(storage.database.connection.prepare("SELECT count(*) AS count FROM projection_settlement").get()).toEqual({ count: 0 });
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps revisions, open goals, and request identities consistent across both stores", () => {
    withTemporaryRepository((repository, storage) => {
      const goal = repository.insertGoal({ id: "temporary-goal", sessionId: "temporary", objective: "finish", maxAutoTurns: 2 });
      const formal = repository.insertGoal({ id: "formal-goal", sessionId: "formal", objective: "formal", maxAutoTurns: 1 });
      expect(repository.listActiveGoalIds()).toEqual([formal.id, goal.id]);
      expect(() => repository.insertGoal({ id: "another", sessionId: "temporary", objective: "duplicate", maxAutoTurns: 2 })).toThrow("Session already has an open goal");
      expect(() => repository.insertGoal({ id: formal.id, sessionId: "temporary", objective: "duplicate", maxAutoTurns: 2 })).toThrow("UNIQUE constraint failed");
      expect(() => repository.insertGoal({ id: goal.id, sessionId: "formal", objective: "duplicate", maxAutoTurns: 2 })).toThrow("UNIQUE constraint failed");
      const updated = repository.updateGoalRevision(goal.id, {
        expectedRevision: 0,
        evidence: ["first"],
        wait: { kind: "external", handleId: "handle", runId: "external-run", deadlineAt: 100 },
      });
      expect(updated).toMatchObject({ revision: 1, evidence: ["first"] });
      updated.evidence.push("caller-change");
      expect(repository.getGoal(goal.id)?.evidence).toEqual(["first"]);
      expect(() => repository.updateGoalRevision(goal.id, { expectedRevision: 0, status: "paused" })).toThrow("session_goal_revision_conflict");
      expect(repository.listActiveExternalWaitGoals().map((row) => row.id)).toEqual([goal.id]);
      repository.bindCurrentRun(goal.id, 0, "stale-run", true);
      expect(repository.getGoal(goal.id)?.currentRunId).toBeUndefined();
      repository.bindCurrentRun(goal.id, 1, "temporary-run", true);
      expect(repository.getGoal(goal.id)).toMatchObject({ currentRunId: "temporary-run", autoTurnsUsed: 1 });
      expect(repository.findGoalIdByCurrentRun("temporary-run")).toBe(goal.id);
      repository.clearCurrentRun(goal.id);
      expect(repository.getGoal(goal.id)?.currentRunId).toBeUndefined();
      repository.updateGoalRevision(goal.id, { expectedRevision: 1, status: "completed" });
      const replacement = repository.insertGoal({ id: "replacement", sessionId: "temporary", objective: "next", maxAutoTurns: 2 });
      expect(repository.getCurrentGoal("temporary")?.id).toBe(replacement.id);
      expect(() => repository.updateGoalRevision(goal.id, { expectedRevision: 2, status: "active" })).toThrow("Session already has an open goal");

      const request = { requestId: "request", sessionId: "temporary", fingerprint: "same" };
      expect(repository.beginRequest(request)).toEqual(repository.beginRequest(request));
      expect(() => repository.beginRequest({ ...request, fingerprint: "different" })).toThrow("session_goal_request_conflict");
      expect(() => repository.beginRequest({ ...request, sessionId: "formal" })).toThrow("session_goal_request_conflict");
      const returned = repository.settleRequest(request.requestId, { status: "completed", result: { value: ["saved"] } });
      (returned.result!.value as string[]).push("caller-change");
      expect(repository.getRequest(request.requestId)?.result).toEqual({ value: ["saved"] });
      expect(() => repository.settleRequest("missing", { status: "failed" })).toThrow("Session goal request not found");
      expect(storage.database.connection.prepare("SELECT id FROM session_goal").all()).toEqual([{ id: formal.id }]);
    });
  });

  it("upserts temporary assessments and deduplicates continuation claims", () => {
    withTemporaryRepository((repository, storage) => {
      const goal = repository.insertGoal({ id: "temporary-goal", sessionId: "temporary", objective: "finish", maxAutoTurns: 2 });
      const assessment = { goalId: goal.id, revision: 0, runId: "run", assessment: { verifiedSignatures: ["first"] } };
      repository.recordAssessment(assessment);
      repository.recordAssessment({ ...assessment, assessment: { verifiedSignatures: ["updated"] } });
      expect(repository.evidenceSignatures(goal.id)).toEqual(["updated"]);
      expect(storage.temporaryControls!.assessments.size).toBe(1);
      expect(() => repository.recordAssessment({ ...assessment, goalId: "missing" })).toThrow("FOREIGN KEY constraint failed");
      const continuation = { goalId: goal.id, revision: 0, previousRunId: "previous", inputId: "input", runId: "next-run" };
      expect(repository.recordContinuation({ ...continuation, revision: Number.NaN })).toBe(false);
      expect(repository.recordContinuation(continuation)).toBe(true);
      expect(repository.recordContinuation(continuation)).toBe(false);
      expect(() => repository.recordContinuation({ ...continuation, goalId: "missing" })).toThrow("FOREIGN KEY constraint failed");
      repository.markContinuation("next-run", "dispatched");
      expect([...storage.temporaryControls!.continuations.values()]).toMatchObject([{ status: "dispatched" }]);
      expect(repository.recordContinuation({ ...continuation, previousRunId: "previous-2", runId: "pending-run" })).toBe(true);
      repository.cancelPendingContinuations();
      expect([...storage.temporaryControls!.continuations.values()].map((row) => row.status)).toEqual(["dispatched", "cancelled"]);
      expect(storage.database.connection.prepare("SELECT count(*) AS count FROM session_goal_assessment").get()).toEqual({ count: 0 });
      expect(storage.database.connection.prepare("SELECT count(*) AS count FROM session_goal_continuation").get()).toEqual({ count: 0 });
    });
  });

  it("preserves settlement identity, retries, and terminal guards in memory", () => {
    withTemporaryRepository((_repository, storage) => {
      const database = storage.database.orm;
      const controls = storage.temporaryControls!;
      const created = createProjectionSettlement(database, settlementInput, controls, "memory");
      expect(createProjectionSettlement(database, settlementInput, controls, "memory")).toEqual(created);
      expect(() => createProjectionSettlement(database, { ...settlementInput, payload: { taskId: "other" } }, controls, "memory")).toThrow("Projection settlement identity conflict");
      expect(() => createProjectionSettlement(database, { ...settlementInput, rootSessionId: "formal" }, controls)).toThrow("UNIQUE constraint failed");
      createProjectionSettlement(database, { ...settlementInput, id: "formal-settlement", rootSessionId: "formal", eventSequence: 3 }, controls);
      expect(listProjectionSettlements(database, { status: "pending" }, controls).map((row) => row.id)).toHaveLength(2);
      expect(listProjectionSettlements(database, { rootSessionId: "temporary" }, controls).map((row) => row.id)).toEqual([created.id]);
      const returned = getProjectionSettlement(database, created.id, controls)!;
      returned.payload.taskId = "caller-change";
      expect(getProjectionSettlement(database, created.id, controls)?.payload).toEqual({ taskId: "task-1" });
      expect(markProjectionSettlementRetrying(database, created.id, controls)).toMatchObject({ status: "retrying", attemptCount: 1 });
      expect(failProjectionSettlement(database, created.id, "retry", 123, controls)).toMatchObject({ status: "pending", attemptCount: 1, lastError: "retry", nextRetryAt: 123 });
      expect(markProjectionSettlementRetrying(database, created.id, controls)).toMatchObject({ status: "retrying", attemptCount: 2 });
      const resolved = resolveProjectionSettlement(database, created.id, controls);
      expect(resolved).toMatchObject({ status: "resolved", attemptCount: 2, resolvedAt: expect.any(Number) });
      const resolvedAgain = resolveProjectionSettlement(database, created.id, controls);
      expect(resolvedAgain.resolvedAt).toBe(resolved.resolvedAt);
      expect(failProjectionSettlement(database, created.id, "late", undefined, controls)).toEqual(resolvedAgain);
      expect(abandonProjectionSettlement(database, created.id, "late", controls).status).toBe("resolved");
      expect(markProjectionSettlementRetrying(database, created.id, controls).attemptCount).toBe(2);
      const abandoned = createProjectionSettlement(database, { ...settlementInput, id: "abandoned", eventSequence: 4 }, controls, "memory");
      abandonProjectionSettlement(database, abandoned.id, "give up", controls);
      expect(resolveProjectionSettlement(database, abandoned.id, controls)).toMatchObject({ status: "abandoned", lastError: "give up" });
      expect(markProjectionSettlementRetrying(database, abandoned.id, controls).attemptCount).toBe(0);
      expect(failProjectionSettlement(database, abandoned.id, "late", undefined, controls).lastError).toBe("give up");
      expect(() => markProjectionSettlementRetrying(database, "missing", controls)).toThrow("Projection settlement not found");
      expect(storage.database.connection.prepare("SELECT id FROM projection_settlement").all()).toEqual([{ id: "formal-settlement" }]);
    });
  });

  it("restores all temporary control rows when an outer transaction fails", () => {
    withTemporaryRepository((repository, storage, store) => {
      const original = repository.insertGoal({ id: "original", sessionId: "temporary", objective: "finish", maxAutoTurns: 2 });
      expect(() => store.transaction(() => {
        repository.updateGoalRevision(original.id, { expectedRevision: 0, status: "completed" });
        repository.insertGoal({ id: "rolled-back", sessionId: "temporary", objective: "next", maxAutoTurns: 2 });
        repository.beginRequest({ requestId: "rolled-back", sessionId: "temporary", fingerprint: "same" });
        repository.recordAssessment({ goalId: original.id, revision: 0, runId: "run", assessment: { verifiedSignatures: ["temporary"] } });
        repository.recordContinuation({ goalId: original.id, revision: 0, previousRunId: "previous", inputId: "input", runId: "run" });
        createProjectionSettlement(storage.database.orm, settlementInput, storage.temporaryControls, "memory");
        throw new Error("rollback controls");
      })).toThrow("rollback controls");
      expect(repository.getGoal(original.id)).toMatchObject({ status: "active", revision: 0 });
      expect(repository.getGoal("rolled-back")).toBeUndefined();
      expect(repository.getRequest("rolled-back")).toBeUndefined();
      expect(repository.evidenceSignatures(original.id)).toEqual([]);
      expect(storage.temporaryControls!.continuations.size).toBe(0);
      expect(listProjectionSettlements(storage.database.orm, {}, storage.temporaryControls)).toEqual([]);
    });
  });

  it("deletes only the selected temporary session and can restore its control snapshot", () => {
    withTemporaryRepository((repository, storage) => {
      const controls = storage.temporaryControls!;
      const goal = repository.insertGoal({ id: "temporary-goal", sessionId: "temporary", objective: "finish", maxAutoTurns: 2 });
      repository.insertGoal({ id: "formal-goal", sessionId: "formal", objective: "formal", maxAutoTurns: 1 });
      repository.beginRequest({ requestId: "request", sessionId: "temporary", fingerprint: "same" });
      repository.recordAssessment({ goalId: goal.id, revision: 0, runId: "run", assessment: { verifiedSignatures: ["saved"] } });
      repository.recordContinuation({ goalId: goal.id, revision: 0, previousRunId: "previous", inputId: "input", runId: "run" });
      createProjectionSettlement(storage.database.orm, settlementInput, controls, "memory");
      const snapshot = controls.snapshot();
      controls.deleteSession("temporary");
      expect(repository.getGoal(goal.id)).toBeUndefined();
      expect(repository.getGoal("formal-goal")?.objective).toBe("formal");
      expect(controls.requests.size).toBe(0);
      expect(controls.assessments.size).toBe(0);
      expect(controls.continuations.size).toBe(0);
      expect(controls.settlements.size).toBe(0);
      controls.restore(snapshot);
      expect(repository.getGoal(goal.id)?.objective).toBe("finish");
      expect(repository.getRequest("request")?.status).toBe("pending");
      expect(repository.evidenceSignatures(goal.id)).toEqual(["saved"]);
      expect([...controls.continuations.values()]).toMatchObject([{ status: "pending" }]);
      expect(getProjectionSettlement(storage.database.orm, settlementInput.id, controls)?.status).toBe("pending");
      controls.goals.get(goal.id)!.objective = "mutated after restoration";
      controls.restore(snapshot);
      expect(repository.getGoal(goal.id)?.objective).toBe("finish");
    });
  });
});

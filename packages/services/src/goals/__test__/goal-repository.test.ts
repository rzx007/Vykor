import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { SessionStore } from "../../session-runtime/store.js";
import { GoalRepository } from "../goal-repository.js";

function withRepository(
  test: (repository: GoalRepository, store: SessionStore) => void,
): void {
  const directory = mkdtempSync(join(tmpdir(), "vk-goal-repository-"));
  const store = new SessionStore({ path: join(directory, "sessions.db") });
  try {
    store.sessions.create({ id: "s1", cwd: process.cwd(), model: "m" });
    store.sessions.create({ id: "s2", cwd: process.cwd(), model: "m" });
    test(new GoalRepository((store as any).storage), store);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("GoalRepository", () => {
  it("lists only pending requests for the requested session, including temporary sessions", () => {
    withRepository((repository, store) => {
      store.sessions.create({ id: "temporary", cwd: process.cwd(), model: "m", storage: "memory" });
      for (const [requestId, sessionId] of [["one", "s1"], ["two", "s2"], ["memory", "temporary"]]) {
        store.goals.beginGoalRequest({ requestId, sessionId, fingerprint: requestId });
      }
      store.goals.beginGoalRequest({ requestId: "done", sessionId: "s1", fingerprint: "done" });
      store.goals.settleGoalRequest("done", { status: "completed" });
      expect(repository.listPendingRequests("s1").map(row => row.requestId)).toEqual(["one"]);
      expect(repository.listPendingRequests("temporary").map(row => row.requestId)).toEqual(["memory"]);
      expect(repository.listPendingRequests().map(row => row.requestId).sort()).toEqual(["memory", "one", "two"]);
    });
  });
  it("changes objectiveVersion only when objective changes", () => {
    withRepository((repository) => {
      const first = repository.insertGoal({ id: "versioned", sessionId: "s1", objective: "finish", maxAutoTurns: 2 });
      expect(first.objectiveVersion).toBe(1);
      const paused = repository.updateGoalRevision(first.id, {
        expectedRevision: first.revision, status: "paused", stopReason: { code: "user_paused", at: 100 },
      });
      expect(paused.objectiveVersion).toBe(1);
      expect(paused.stopReason).toEqual({ code: "user_paused", at: 100 });
      const same = repository.updateGoalRevision(first.id, { expectedRevision: paused.revision, objective: "finish" });
      expect(same.objectiveVersion).toBe(1);
      expect(() => repository.updateGoalRevision(first.id, { expectedRevision: same.revision, objectiveVersion: 2 })).toThrow("goal_version_binding_invalid");
      expect(() => repository.updateGoalRevision(first.id, { expectedRevision: same.revision, objective: "changed", objectiveVersion: 1 })).toThrow("goal_version_binding_invalid");
      const edited = repository.updateGoalRevision(first.id, {
        expectedRevision: same.revision, objective: "finish and verify", stopReason: null,
      });
      expect(edited.objectiveVersion).toBe(2);
      expect(edited.revision).toBe(same.revision + 1);
      expect(edited.stopReason).toBeUndefined();
    });
  });

  it("reloads requests and continuations from disk", () => {
    const directory = mkdtempSync(join(tmpdir(), "vk-goal-related-reload-"));
    const path = join(directory, "sessions.db");
    try {
      const first = new SessionStore({ path });
      first.sessions.create({ id: "s1", cwd: process.cwd(), model: "m" });
      const goal = first.goals.createGoal({
        id: "goal-related",
        sessionId: "s1",
        objective: "related",
        maxAutoTurns: 2,
      });
      first.goals.updateGoal(goal.id, {
        expectedRevision: 0,
        wait: { kind: "user", questionId: "q1", question: "continue?", objectiveVersion: 1 },
      });
      first.goals.beginGoalRequest({
        requestId: "request-related",
        sessionId: "s1",
        fingerprint: "fingerprint",
      });
      first.goals.settleGoalRequest("request-related", {
        status: "completed",
        goalId: goal.id,
        result: { runId: "run-related" },
      });
      first.goals.recordGoalContinuation({
        goalId: goal.id,
        revision: 1,
        previousRunId: "previous-related",
        inputId: "input-related",
        runId: "run-related",
      });
      first.close();

      const second = new SessionStore({ path });
      try {
        expect(second.goals.getGoal(goal.id)).toMatchObject({
          wait: { questionId: "q1" },
        });
        expect(second.goals.getGoalRequest("request-related")).toMatchObject({
          result: { runId: "run-related" },
        });
        const continuation = (second as any).storage.database.connection
          .prepare(
            "SELECT status FROM session_goal_continuation WHERE run_id = ?",
          )
          .get("run-related");
        expect(continuation).toEqual({ status: "pending" });

        const database = (second as any).storage.database.connection;
        database
          .prepare(
            "UPDATE session_goal_request SET result_json = ? WHERE request_id = ?",
          )
          .run("{broken", "request-related");
        expect(() => second.goals.getGoalRequest("request-related")).toThrow(
          SyntaxError,
        );
        database
          .prepare("UPDATE session_goal SET wait_json = ? WHERE id = ?")
          .run("{broken", goal.id);
        expect(() => second.goals.getGoal(goal.id)).toThrow(SyntaxError);
      } finally {
        second.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reloads goal rows, isolates returned values, and rejects malformed JSON", () => {
    const directory = mkdtempSync(join(tmpdir(), "vk-goal-reload-"));
    const path = join(directory, "sessions.db");
    try {
      const first = new SessionStore({ path });
      first.sessions.create({ id: "s1", cwd: process.cwd(), model: "m" });
      const goal = first.goals.createGoal({
        id: "goal-reload",
        sessionId: "s1",
        objective: "reload",
        maxAutoTurns: 2,
      });
      first.goals.updateGoal(goal.id, {
        expectedRevision: 0,
        wait: { kind: "user", questionId: "q1", question: "continue?", objectiveVersion: 1 },
      });
      const returned = first.goals.getGoal(goal.id)!;
      if (returned.wait?.kind === "user") returned.wait.question = "caller-change";
      expect(first.goals.getGoal(goal.id)?.wait).toMatchObject({ question: "continue?" });
      first.close();

      const second = new SessionStore({ path });
      try {
        expect(second.goals.getGoal(goal.id)).toMatchObject({
          objective: "reload",
          revision: 1,
          wait: { kind: "user", questionId: "q1", question: "continue?", objectiveVersion: 1 },
        });
        (second as any).storage.database.connection
          .prepare("UPDATE session_goal SET wait_json = ? WHERE id = ?")
          .run("{broken", goal.id);
        expect(() => second.goals.getGoal(goal.id)).toThrow(SyntaxError);
      } finally {
        second.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps goal requests idempotent by session and fingerprint", () => {
    withRepository((repository) => {
      const request = repository.beginRequest({
        requestId: "request-1",
        sessionId: "s1",
        fingerprint: "same",
      });

      expect(
        repository.beginRequest({
          requestId: "request-1",
          sessionId: "s1",
          fingerprint: "same",
        }),
      ).toEqual(request);
      expect(() =>
        repository.beginRequest({
          requestId: "request-1",
          sessionId: "s1",
          fingerprint: "different",
        }),
      ).toThrow("session_goal_request_conflict");
      expect(() =>
        repository.beginRequest({
          requestId: "request-1",
          sessionId: "s2",
          fingerprint: "same",
        }),
      ).toThrow("session_goal_request_conflict");

      expect(
        repository.settleRequest("request-1", {
          status: "completed",
          goalId: "goal-1",
          result: { runId: "run-1" },
        }),
      ).toMatchObject({
        status: "completed",
        goalId: "goal-1",
        result: { runId: "run-1" },
      });
    });
  });

  it("ignores invalid continuation values without swallowing foreign-key failures", () => {
    withRepository((repository, store) => {
      const goal = store.goals.createGoal({
        id: "goal-invalid-continuation",
        sessionId: "s1",
        objective: "finish",
        maxAutoTurns: 2,
      });
      const continuation = {
        goalId: goal.id,
        revision: goal.revision,
        previousRunId: "previous-run",
        inputId: "input-1",
        runId: "run-2",
      };

      expect(repository.recordContinuation({ ...continuation, revision: Number.NaN })).toBe(false);
      expect((store as any).storage.database.connection
        .prepare("SELECT count(*) AS count FROM session_goal_continuation").get()).toEqual({ count: 0 });
      expect(() => repository.recordContinuation({ ...continuation, goalId: "missing-goal" }))
        .toThrow("FOREIGN KEY constraint failed");
      expect(repository.recordContinuation(continuation)).toBe(true);
    });
  });

  it("deduplicates continuations", () => {
    withRepository((repository, store) => {
      const goal = store.goals.createGoal({
        id: "goal-1",
        sessionId: "s1",
        objective: "finish",
        maxAutoTurns: 2,
      });
      const continuation = {
        goalId: goal.id,
        revision: goal.revision,
        previousRunId: "previous-run",
        inputId: "input-1",
        runId: "run-2",
      };
      expect(repository.recordContinuation(continuation)).toBe(true);
      expect(repository.recordContinuation(continuation)).toBe(false);
      repository.markContinuation("run-2", "dispatched");
      const row = (store as any).storage.database.connection
        .prepare(
          "SELECT status FROM session_goal_continuation WHERE run_id = ?",
        )
        .get("run-2");
      expect(row).toEqual({ status: "dispatched" });
    });
  });
});

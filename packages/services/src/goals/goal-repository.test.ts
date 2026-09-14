import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { SessionStore } from "../session-runtime/store.js";
import { GoalRepository } from "./goal-repository.js";

function withRepository(
  test: (repository: GoalRepository, store: SessionStore) => void,
): void {
  const directory = mkdtempSync(join(tmpdir(), "ohs-goal-repository-"));
  const store = new SessionStore({ path: join(directory, "sessions.db") });
  try {
    store.createSession({ id: "s1", cwd: process.cwd(), model: "m" });
    store.createSession({ id: "s2", cwd: process.cwd(), model: "m" });
    test(new GoalRepository((store as any).storage), store);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("GoalRepository", () => {
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

  it("upserts assessments and deduplicates continuations", () => {
    withRepository((repository, store) => {
      const goal = store.createGoal({
        id: "goal-1",
        sessionId: "s1",
        objective: "finish",
        maxAutoTurns: 2,
      });
      repository.recordAssessment({
        goalId: goal.id,
        revision: goal.revision,
        runId: "run-1",
        assessment: { verifiedSignatures: ["first"] },
      });
      repository.recordAssessment({
        goalId: goal.id,
        revision: goal.revision,
        runId: "run-1",
        assessment: { verifiedSignatures: ["updated"] },
      });
      expect(repository.evidenceSignatures(goal.id)).toEqual(["updated"]);

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

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
    store.sessions.create({ id: "s1", cwd: process.cwd(), model: "m" });
    store.sessions.create({ id: "s2", cwd: process.cwd(), model: "m" });
    test(new GoalRepository((store as any).storage), store);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("GoalRepository", () => {
  it("reloads requests, assessments, and continuations from disk", () => {
    const directory = mkdtempSync(join(tmpdir(), "ohs-goal-related-reload-"));
    const path = join(directory, "sessions.db");
    try {
      const first = new SessionStore({ path });
      first.createSession({ id: "s1", cwd: process.cwd(), model: "m" });
      const goal = first.goals.createGoal({
        id: "goal-related",
        sessionId: "s1",
        objective: "related",
        maxAutoTurns: 2,
      });
      first.goals.updateGoal(goal.id, {
        expectedRevision: 0,
        wait: { kind: "user", questionId: "q1", question: "continue?" },
        assessment: { decision: "continue", evidenceRefs: [], reason: "more" },
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
      first.goals.recordGoalAssessment({
        goalId: goal.id,
        revision: 1,
        runId: "run-related",
        assessment: { verifiedSignatures: ["signature"] },
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
          assessment: { decision: "continue" },
        });
        expect(second.goals.getGoalRequest("request-related")).toMatchObject({
          result: { runId: "run-related" },
        });
        expect(second.goals.goalEvidenceSignatures(goal.id)).toEqual([
          "signature",
        ]);
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
        database
          .prepare(
            "UPDATE session_goal_assessment SET assessment_json = ? WHERE goal_id = ?",
          )
          .run("{broken", goal.id);
        expect(() => second.goals.goalEvidenceSignatures(goal.id)).toThrow(
          SyntaxError,
        );
      } finally {
        second.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reloads goal rows, isolates returned values, and rejects malformed JSON", () => {
    const directory = mkdtempSync(join(tmpdir(), "ohs-goal-reload-"));
    const path = join(directory, "sessions.db");
    try {
      const first = new SessionStore({ path });
      first.createSession({ id: "s1", cwd: process.cwd(), model: "m" });
      const goal = first.goals.createGoal({
        id: "goal-reload",
        sessionId: "s1",
        objective: "reload",
        maxAutoTurns: 2,
      });
      first.goals.updateGoal(goal.id, {
        expectedRevision: 0,
        evidence: ["e1"],
        assessment: { decision: "continue", evidenceRefs: [], reason: "more" },
      });
      const returned = first.goals.getGoal(goal.id)!;
      returned.evidence.push("caller-change");
      expect(first.goals.getGoal(goal.id)?.evidence).toEqual(["e1"]);
      first.close();

      const second = new SessionStore({ path });
      try {
        expect(second.goals.getGoal(goal.id)).toMatchObject({
          objective: "reload",
          revision: 1,
          evidence: ["e1"],
        });
        (second as any).storage.database.connection
          .prepare("UPDATE session_goal SET evidence_json = ? WHERE id = ?")
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

  it("upserts assessments and deduplicates continuations", () => {
    withRepository((repository, store) => {
      const goal = store.goals.createGoal({
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

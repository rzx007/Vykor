import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { SessionStore } from "../session-runtime/store.js";

function withStore(test: (store: SessionStore) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "ohs-goal-transactions-"));
  const store = new SessionStore({ path: join(directory, "sessions.db") });
  try {
    store.createSession({ id: "s1", cwd: process.cwd(), model: "m" });
    test(store);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function failGoalEvent(store: SessionStore, type: string): void {
  (store as any).storage.database.connection.exec(`
    CREATE TRIGGER fail_goal_event
    BEFORE INSERT ON session_event
    WHEN NEW.type = '${type}'
    BEGIN
      SELECT RAISE(ABORT, 'forced goal event failure');
    END;
  `);
}

describe("GoalTransactions", () => {
  it("rolls back goal creation when its durable event fails", () => {
    withStore((store) => {
      failGoalEvent(store, "session.goal.created");

      expect(() =>
        store.goals.createGoal({
          id: "goal-1",
          sessionId: "s1",
          objective: "finish",
          maxAutoTurns: 2,
        }),
      ).toThrow("forced goal event failure");
      expect(store.goals.getGoal("goal-1")).toBeUndefined();
      expect(
        store
          .listEvents()
          .some((event) => event.type === "session.goal.created"),
      ).toBe(false);
    });
  });

  it("rolls back update and start when their durable event fails", () => {
    withStore((store) => {
      const goal = store.goals.createGoal({
        id: "goal-1",
        sessionId: "s1",
        objective: "finish",
        maxAutoTurns: 2,
      });
      const run = store.createRun({ id: "run-1", sessionId: "s1" });
      failGoalEvent(store, "session.goal.updated");

      expect(() =>
        store.goals.updateGoal(goal.id, {
          expectedRevision: goal.revision,
          status: "paused",
        }),
      ).toThrow("forced goal event failure");
      expect(store.goals.getGoal(goal.id)).toMatchObject({
        revision: 0,
        status: "active",
      });

      expect(() => store.goals.startGoalRun(goal.id, 0, run.id, true)).toThrow(
        "forced goal event failure",
      );
      expect(store.goals.getGoal(goal.id)).toMatchObject({
        autoTurnsUsed: 0,
      });
      expect(store.goals.getGoal(goal.id)?.currentRunId).toBeUndefined();
    });
  });

  it("rolls back clearing currentRunId when the finish event fails", () => {
    withStore((store) => {
      const goal = store.goals.createGoal({
        id: "goal-1",
        sessionId: "s1",
        objective: "finish",
        maxAutoTurns: 2,
      });
      const run = store.createRun({ id: "run-1", sessionId: "s1" });
      expect(store.goals.startGoalRun(goal.id, 0, run.id, false)).toBe(true);
      failGoalEvent(store, "session.goal.updated");

      expect(() => store.goals.finishGoalRun(run.id)).toThrow(
        "forced goal event failure",
      );
      expect(store.goals.getGoal(goal.id)?.currentRunId).toBe(run.id);
    });
  });
});

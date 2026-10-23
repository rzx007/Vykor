import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { SessionStore } from "../../session-runtime/store.js";

function withStore(test: (store: SessionStore) => void, storage: "sqlite" | "memory" = "sqlite"): void {
  const directory = mkdtempSync(join(tmpdir(), "vk-goal-transactions-"));
  const store = new SessionStore({ path: join(directory, "sessions.db") });
  try {
    store.sessions.create({ id: "s1", cwd: process.cwd(), model: "m", storage });
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
  it.each(["sqlite", "memory"] as const)("reconciles only the requested terminal Run and leaves active attempts untouched (%s)", storage => {
    withStore(store => {
      const goal = store.goals.createGoal({ sessionId: "s1", objective: "finish", maxAutoTurns: 2, tokenBudget: 100 });
      for (const id of ["ended", "active"]) {
        store.runs.createRun({ id, sessionId: "s1", metadata: { goalId: goal.id, goalObjectiveVersion: goal.objectiveVersion } });
        store.runs.updateRun(id, { status: "running" });
        store.goals.beginGoalModelAttempt({ runId: id, sessionId: "s1", generationId: id, attempt: 1, model: "m", purpose: "generation" });
      }
      store.runs.updateRun("ended", { status: "failed" });
      expect(store.goals.reconcileGoalModelAttempts("ended")).toBe(1);
      expect(store.goals.getGoal(goal.id)?.usage).toMatchObject({ unknownAttempts: 1, inFlightAttempts: 1, incomplete: true });
      expect(store.goals.reconcileGoalModelAttempts("ended")).toBe(0);
      expect(store.goals.getGoal(goal.id)?.usage.inFlightAttempts).toBe(1);
    }, storage);
  });

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
        store.conversations
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
      const run = store.runs.createRun({ id: "run-1", sessionId: "s1" });
      failGoalEvent(store, "session.goal.updated");

      expect(() =>
        store.goals.updateGoal(goal.id, {
          expectedRevision: goal.revision,
          status: "paused",
          objective: "changed",
          stopReason: { code: "user_paused", at: 10 },
        }),
      ).toThrow("forced goal event failure");
      expect(store.goals.getGoal(goal.id)).toMatchObject({
        revision: 0,
        objectiveVersion: 1,
        objective: "finish",
        status: "active",
      });

      expect(() => store.goals.startGoalRun(goal.id, goal.objectiveVersion, run.id, true)).toThrow(
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
      const run = store.runs.createRun({ id: "run-1", sessionId: "s1" });
      expect(store.goals.startGoalRun(goal.id, goal.objectiveVersion, run.id, false)).toBe(true);
      failGoalEvent(store, "session.goal.updated");

      expect(() => store.goals.finishGoalRun(run.id)).toThrow(
        "forced goal event failure",
      );
      expect(store.goals.getGoal(goal.id)?.currentRunId).toBe(run.id);
    });
  });

  it("rolls back an inner goal creation when the outer transaction fails", () => {
    const directory = mkdtempSync(join(tmpdir(), "vk-goal-outer-"));
    const path = join(directory, "sessions.db");
    const store = new SessionStore({ path });
    try {
      store.sessions.create({ id: "s1", cwd: process.cwd(), model: "m" });
      const internals = (store as any).storage;
      const beforeSequence = internals.state.nextEventSeq;
      expect(() =>
        store.transaction(() => {
          store.goals.createGoal({
            id: "goal-outer",
            sessionId: "s1",
            objective: "outer",
            maxAutoTurns: 2,
          });
          store.conversationTransactions.admitPromptWithRun({
            prompt: {
              id: "input-outer",
              sessionId: "s1",
              content: "continue",
            },
            run: { id: "run-outer", metadata: { goalId: "goal-outer" } },
          });
          throw new Error("outer failed");
        }),
      ).toThrow("outer failed");
      expect(store.goals.getGoal("goal-outer")).toBeUndefined();
      expect(store.conversations.getInput("input-outer")).toBeUndefined();
      expect(store.runs.getRun("run-outer")).toBeUndefined();
      expect(internals.state.nextEventSeq).toBe(beforeSequence);
      expect(internals.mutations.inputs.size).toBe(0);
      expect(internals.mutations.runs.size).toBe(0);
      expect(
        store.conversations
          .listEvents()
          .some((event) => event.type.startsWith("session.goal")),
      ).toBe(false);
      store.close();

      const reopened = new SessionStore({ path });
      try {
        expect(reopened.goals.getGoal("goal-outer")).toBeUndefined();
        expect(reopened.conversations.getInput("input-outer")).toBeUndefined();
        expect(reopened.runs.getRun("run-outer")).toBeUndefined();
        expect(
          reopened.conversations
            .listEvents()
            .some((event) => event.type.startsWith("session.goal")),
        ).toBe(false);
      } finally {
        reopened.close();
      }
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fences every goal write family after owner takeover", () => {
    const directory = mkdtempSync(join(tmpdir(), "vk-goal-owner-"));
    const path = join(directory, "sessions.db");
    const first = new SessionStore({ path });
    const second = new SessionStore({ path });
    try {
      first.acquireApplicationOwner({
        ownerId: "first",
        pid: 1,
        staleAfterMs: 100,
        now: 1_000,
      });
      first.sessions.create({ id: "s1", cwd: process.cwd(), model: "m" });
      const goal = first.goals.createGoal({
        id: "goal-1",
        sessionId: "s1",
        objective: "owner",
        maxAutoTurns: 2,
      });
      second.acquireApplicationOwner({
        ownerId: "second",
        pid: 2,
        staleAfterMs: 100,
        now: 1_101,
      });

      const writes = [
        () =>
          first.goals.updateGoal(goal.id, {
            expectedRevision: 0,
            status: "paused",
          }),
        () =>
          first.goals.beginGoalRequest({
            requestId: "request",
            sessionId: "s1",
            fingerprint: "f",
          }),
        () => first.goals.beginGoalVersion({ goalId: goal.id, objectiveVersion: 1, objective: goal.objective,
          requestId: "version", actor: { kind: "local_user" }, createdAt: 1 }),
        () =>
          first.goals.recordGoalContinuation({
            goalId: goal.id,
            revision: 0,
            previousRunId: "previous",
            inputId: "input",
            runId: "run",
          }),
      ];
      for (const write of writes) expect(write).toThrow();
      expect(first.goals.getGoal(goal.id)).toMatchObject({
        revision: 0,
        objectiveVersion: 1,
        objective: "owner",
        status: "active",
      });
      expect(first.goals.getGoalRequest("request")).toBeUndefined();
    } finally {
      first.close();
      second.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

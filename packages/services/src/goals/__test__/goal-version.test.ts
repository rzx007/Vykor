import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { GoalVersion } from "@vykor/domain-contracts/goals";
import type { StorageContext } from "../../database/storage-context.js";
import { SessionStore } from "../../session-runtime/store.js";

const version: GoalVersion = { goalId: "g1", objectiveVersion: 1, objective: "tests pass", requestId: "request1", actor: { kind: "local_user" }, createdAt: 100 };

function withStore(test: (store: SessionStore, storage: StorageContext, path: string) => void, memory = false): void {
  const directory = mkdtempSync(join(tmpdir(), "vk-goal-version-"));
  const path = join(directory, "store.db");
  const store = new SessionStore({ path });
  try {
    store.sessions.create({ id: "s1", cwd: directory, model: "m", ...(memory ? { storage: "memory" } : {}) });
    store.goals.createGoal({ id: "g1", sessionId: "s1", objective: "tests pass", maxAutoTurns: 0 });
    test(store, (store as unknown as { storage: StorageContext }).storage, path);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
}

describe("Goal objective versions", () => {
  it.each([false, true])("stores an immutable request identity (memory=%s)", memory => {
    withStore(store => {
      expect(store.goals.beginGoalVersion(version)).toEqual(version);
      expect(store.goals.beginGoalVersion(version)).toEqual(version);
      for (const extra of [{ requestId: "other" }, { objective: "changed" }, { createdAt: 101 }, { actor: { kind: "authenticated_user" as const, id: "other" } }])
        expect(() => store.goals.beginGoalVersion({ ...version, ...extra })).toThrow("goal_version_conflict");
      expect(store.goals.listGoalVersions("g1")).toEqual([version]);
    }, memory);
  });

  it.each([false, true])("records edits with their previous version while preserving usage and turns (memory=%s)", memory => {
    withStore(store => {
      store.goals.beginGoalVersion(version);
      store.runs.createRun({ id: "r1", sessionId: "s1" });
      store.goals.startGoalRun("g1", 1, "r1", true);
      store.goals.updateGoal("g1", { expectedRevision: 0, objective: "tests pass and document", status: "paused" });
      const edit: GoalVersion = { ...version, objectiveVersion: 2, previousVersion: 1, objective: "tests pass and document", requestId: "edit", createdAt: 101 };
      expect(() => store.goals.beginGoalVersion({ ...edit, previousVersion: undefined })).toThrow("goal_version_previous_invalid");
      expect(() => store.goals.beginGoalVersion({ ...edit, requestId: version.requestId })).toThrow("goal_version_conflict");
      expect(store.goals.beginGoalVersion(edit)).toEqual(edit);
      expect(store.goals.getGoal("g1")).toMatchObject({ objectiveVersion: 2, status: "paused", autoTurnsUsed: 1, usage: { knownTokens: 0 } });
      expect(store.goals.startGoalRun("g1", 1, "r1", false)).toBe(false);
      expect(store.goals.listGoalVersions("g1")).toEqual([version, edit]);
    }, memory);
  });

  it.each([false, true])("rolls back a version and objective edit together (memory=%s)", memory => {
    withStore((store, storage) => {
      store.goals.beginGoalVersion(version);
      expect(() => store.transaction(() => {
        store.goals.updateGoal("g1", { expectedRevision: 0, objective: "new" });
        store.goals.beginGoalVersion({ ...version, objectiveVersion: 2, previousVersion: 1, objective: "new", requestId: "edit" });
        throw new Error("rollback edit");
      })).toThrow("rollback edit");
      expect(store.goals.getGoal("g1")).toMatchObject({ revision: 0, objectiveVersion: 1, objective: "tests pass" });
      expect(store.goals.listGoalVersions("g1")).toEqual([version]);
      if (memory) {
        const snapshot = storage.temporaryControls!.snapshot();
        storage.temporaryControls!.deleteSession("s1");
        expect(store.goals.getGoalVersion("g1", 1)).toBeUndefined();
        storage.temporaryControls!.restore(snapshot);
        expect(store.goals.getGoalVersion("g1", 1)).toEqual(version);
        expect(storage.database.connection.prepare("SELECT count(*) AS count FROM session_goal_version").get()).toEqual({ count: 0 });
      }
    }, memory);
  });

  it("reloads simple versions from disk", () => {
    withStore((store, _storage, path) => {
      store.goals.beginGoalVersion(version);
      store.close();
      const reopened = new SessionStore({ path });
      try { expect(reopened.goals.getGoalVersion("g1", 1)).toEqual(version); } finally { reopened.close(); }
    });
  });
});

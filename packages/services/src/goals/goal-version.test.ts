import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { GoalRequirement, GoalVersion } from "@vykor/protocol";
import type { StorageContext } from "../database/storage-context.js";
import { SessionStore } from "../session-runtime/store.js";

const requirement: GoalRequirement = { id: "R1", text: "tests pass", source: [{ kind: "input", inputId: "i1", quote: "tests pass" }],
  verification: { kind: "check", method: "test", environment: "workspace", expected: "passes" }, constraints: [] };
const version: GoalVersion = { goalId: "g1", objectiveVersion: 1, objective: "tests pass", requirements: [], changeKind: "create",
  changeReason: "用户创建", requestId: "request1", actor: { kind: "local_user" }, inputIds: ["i1"], createdAt: 100 };

function withStore(test: (store: SessionStore, storage: StorageContext, path: string) => void, memory = false): void {
  const directory = mkdtempSync(join(tmpdir(), "vk-goal-version-"));
  const path = join(directory, "store.db");
  const store = new SessionStore({ path });
  try {
    store.sessions.create({ id: "s1", cwd: directory, model: "m", ...(memory ? { storage: "memory" } : {}) });
    store.goals.createGoal({ id: "g1", sessionId: "s1", objective: "tests pass", maxAutoTurns: 2 });
    store.goals.beginGoalRequest({ requestId: "request1", sessionId: "s1", fingerprint: "create" });
    test(store, (store as unknown as { storage: StorageContext }).storage, path);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
}

function prepare(store: SessionStore): void {
  store.goals.beginGoalVersion(version);
  store.goals.settleGoalRequest("request1", { status: "completed", goalId: "g1", result: { retained: "value" } });
  store.goals.setPreparationEpisode({ episodeId: "request1", goalId: "g1", objectiveVersion: 1,
    inputIds: ["i1"], modelAttempts: 0, readToolCalls: 0, runId: "r1", state: "running" });
  store.goals.updateGoal("g1", { expectedRevision: 0, preparationEpisodeId: "request1", currentRunId: "r1" });
  store.runs.createRun({ id: "r1", sessionId: "s1", metadata: { goalId: "g1", goalObjectiveVersion: 1,
    goalPhase: "preparing", goalEpisodeId: "request1", goalRunKind: "preparation" } });
  store.runs.updateRun("r1", { status: "running" });
}

describe("Goal versions and preparation episodes", () => {
  it.each([false, true])("replays one immutable version and retains appended sources (memory=%s)", memory => {
    withStore(store => {
      expect(store.goals.beginGoalVersion(version)).toEqual(version);
      store.goals.appendGoalVersionInput("g1", 1, "answer");
      store.goals.appendGoalVersionInput("g1", 1, "answer");
      expect(store.goals.beginGoalVersion(version).inputIds).toEqual(["i1", "answer"]);
      expect(() => store.goals.beginGoalVersion({ ...version, requestId: "other" })).toThrow("goal_version_conflict");
      expect(store.goals.listGoalVersions("g1")).toHaveLength(1);
      expect(store.goals.getCurrentGoal("s1")?.versionSummary).toEqual({ changeKind: "create", changeReason: "用户创建", createdAt: 100 });
    }, memory);
  });

  it.each([false, true])("freezes once, clears the episode pointer, and rejects definition rewrites (memory=%s)", memory => {
    withStore(store => {
      prepare(store);
      const reservation = { runId: "r1", generationId: "before-freeze", attempt: 1, sessionId: "s1", model: "m", purpose: "generation" as const };
      expect(store.goals.beginGoalModelAttempt(reservation)).toMatchObject({ allowed: true });
      store.goals.setPreparationEpisode({ ...store.goals.getPreparationEpisode("request1")!, readyRunId: "r1", state: "ready" });
      const input = { goalId: "g1", objectiveVersion: 1, expectedRevision: 1, runId: "r1", requirements: [requirement] };
      const frozen = store.goals.freezeGoalVersion(input);
      expect(frozen).toMatchObject({ phase: "executing", objectiveVersion: 1, requirements: [requirement], stagnationCount: 0 });
      expect(frozen.preparationEpisodeId).toBeUndefined();
      expect(frozen.currentRunId).toBeUndefined();
      expect(store.goals.freezeGoalVersion(input)).toEqual(frozen);
      expect(() => store.goals.freezeGoalVersion({ ...input, requirements: [{ ...requirement, text: "changed" }] })).toThrow();
      expect(() => store.goals.appendGoalVersionInput("g1", 1, "late")).toThrow("goal_version_frozen");
      expect(store.goals.getGoalVersion("g1", 1)?.frozenAt).toBeTypeOf("number");
      expect(store.goals.beginGoalModelAttempt({ runId: "r1", generationId: "late-preparation", attempt: 1,
        sessionId: "s1", model: "m", purpose: "generation" })).toMatchObject({ allowed: false });
      expect(store.goals.beginGoalModelAttempt(reservation)).toMatchObject({ allowed: false, changed: false });
    }, memory);
  });

  it.each([false, true])("rolls back version, goal, and episode when the freeze event fails (memory=%s)", memory => {
    withStore((store, storage) => {
      prepare(store);
      store.goals.setPreparationEpisode({ ...store.goals.getPreparationEpisode("request1")!, readyRunId: "r1", state: "ready" });
      const emit = vi.spyOn(store.conversations, "appendEvent").mockImplementation(() => { throw new Error("forced freeze event failure"); });
      try {
        expect(() => store.transaction(() => {
          store.goals.setPreparationEpisode({ ...store.goals.getPreparationEpisode("request1")!, readToolCalls: 3 });
          store.goals.freezeGoalVersion({ goalId: "g1", objectiveVersion: 1, expectedRevision: 1, runId: "r1", requirements: [requirement] });
        })).toThrow("forced freeze event failure");
      } finally { emit.mockRestore(); }
      expect(store.goals.getGoalVersion("g1", 1)?.frozenAt).toBeUndefined();
      expect(store.goals.getGoal("g1")).toMatchObject({ phase: "preparing", revision: 1, preparationEpisodeId: "request1" });
      expect(store.goals.getPreparationEpisode("request1")?.readToolCalls).toBe(0);
      if (memory) {
        const snapshot = storage.temporaryControls!.snapshot();
        storage.temporaryControls!.deleteSession("s1");
        expect(store.goals.getGoalVersion("g1", 1)).toBeUndefined();
        storage.temporaryControls!.restore(snapshot);
        expect(store.goals.getGoalVersion("g1", 1)?.inputIds).toEqual(["i1"]);
      }
    }, memory);
  });

  it.each([false, true])("counts only new model reservations and rejects the third model or fifth read (memory=%s)", memory => {
    withStore(store => {
      prepare(store);
      const start = { runId: "r1", generationId: "gen", attempt: 1, sessionId: "s1", model: "m", purpose: "generation" as const };
      expect(store.goals.beginGoalModelAttempt(start)).toMatchObject({ allowed: true, changed: true });
      expect(store.goals.beginGoalModelAttempt(start)).toMatchObject({ allowed: true, changed: false });
      expect(store.goals.beginGoalModelAttempt({ ...start, attempt: 2, purpose: "compaction" })).toMatchObject({ allowed: true });
      for (let i = 0; i < 4; i++) store.goals.reservePreparationTool("request1", "r1");
      expect(() => store.goals.reservePreparationTool("request1", "r1")).toThrow("goal_preparation_tool_limit");
      expect(store.goals.beginGoalModelAttempt({ ...start, attempt: 3 })).toMatchObject({ allowed: false });
      expect(store.goals.getPreparationEpisode("request1")).toMatchObject({ modelAttempts: 2, readToolCalls: 4 });
      expect(store.goals.getGoal("g1")).toMatchObject({ status: "paused", stopReason: { code: "preparation_limit" } });
      expect(store.goals.getGoalRequest("request1")?.result?.retained).toBe("value");
    }, memory);
  });

  it("reopens versions and episodes and filters assessment history by version", () => {
    withStore((store, _storage, path) => {
      prepare(store);
      store.goals.recordGoalAssessment({ goalId: "g1", revision: 1, runId: "r1", assessment: { goalId: "g1", objectiveVersion: 1, runId: "r1" } });
      store.goals.recordGoalAssessment({ goalId: "g1", revision: 2, runId: "r2", assessment: { goalId: "g1", objectiveVersion: 2, runId: "r2" } });
      store.close();
      const reopened = new SessionStore({ path });
      try {
        expect(reopened.goals.getGoalVersion("g1", 1)).toEqual(version);
        expect(reopened.goals.getPreparationEpisode("request1")).toMatchObject({ state: "running", runId: "r1", modelAttempts: 0 });
        expect(reopened.goals.listGoalAssessments("g1", 1)).toEqual([{ goalId: "g1", objectiveVersion: 1, runId: "r1" }]);
      } finally { reopened.close(); }
    });
  });
});

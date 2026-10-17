import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StorageContext } from "../database/storage-context.js";
import { SessionStore } from "../session-runtime/store.js";

afterEach(() => vi.restoreAllMocks());

function withStore(test: (store: SessionStore, storage: StorageContext) => void, memory = false): void {
  const directory = mkdtempSync(join(tmpdir(), "vk-goal-usage-"));
  const store = new SessionStore({ path: join(directory, "store.db") });
  try {
    store.sessions.create({ id: "s1", cwd: directory, model: "m", ...(memory ? { storage: "memory" } : {}) });
    store.goals.createGoal({ id: "g1", sessionId: "s1", objective: "finish", maxAutoTurns: 2 });
    store.runs.createRun({ id: "r1", sessionId: "s1", metadata: { goalId: "g1", goalObjectiveVersion: 1 } });
    store.runs.updateRun("r1", { status: "running" });
    test(store, (store as unknown as { storage: StorageContext }).storage);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
}

const key = { runId: "r1", generationId: "gen1", attempt: 1, sessionId: "s1" };
const start = { ...key, model: "m", purpose: "generation" as const };
function report(input: number, output: number, completeness: "partial" | "complete" | "unknown" = "complete") {
  return { ...key, status: "completed" as const, usageStatus: completeness,
    metering: { knownInputTokens: input, knownOutputTokens: output, completeness,
      inputIncludesCache: true, raw: { input_tokens: input, output_tokens: output } } };
}

describe("Goal model attempt ledger", () => {
  it("meters plugin selection before the main Run starts without allowing other pending requests", () => {
    withStore(store => {
      store.runs.updateRun("r1", { status: "pending" });
      expect(store.goals.beginGoalModelAttempt(start)).toMatchObject({ allowed: false });
      expect(store.goals.beginGoalModelAttempt({ ...start, purpose: "plugin_selection" })).toMatchObject({ allowed: true, changed: true });
      store.goals.recordGoalModelAttempt(report(10, 3));
      expect(store.goals.getGoal("g1")?.usage).toMatchObject({ knownTokens: 13, incomplete: false });
    });
  });
  it.each([false, true])("reads the latest terminal Goal and its late usage without changing open-only queries (memory=%s)", (memory) => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
    withStore((store) => {
      store.goals.beginGoalModelAttempt(start);
      store.goals.recordGoalModelAttempt(report(8, 2, "partial"));
      clock.mockReturnValue(2_000);
      store.goals.updateGoal("g1", { expectedRevision: 0, status: "cancelled", stopReason: { code: "user_cancelled", at: 2_000 } });
      clock.mockReturnValue(2_500);
      store.runs.updateRun("r1", { status: "interrupted" });
      clock.mockReturnValue(3_000);
      store.goals.recordGoalModelAttempt(report(10, 3));
      expect(store.goals.getCurrentGoal("s1")).toBeUndefined();
      expect(store.goals.getCurrentGoal("s1", true)).toMatchObject({ id: "g1", status: "cancelled", revision: 1,
        usage: { knownTokens: 13, incomplete: false, seq: 3 } });

      clock.mockReturnValue(4_000);
      store.goals.createGoal({ id: "g2", sessionId: "s1", objective: "next", maxAutoTurns: 2 });
      clock.mockReturnValue(5_000);
      store.goals.updateGoal("g1", { expectedRevision: 1, reason: "old Goal inspected" });
      expect(store.goals.getCurrentGoal("s1")!.id).toBe("g2");
      expect(store.goals.getCurrentGoal("s1", true)!.id).toBe("g2");
    }, memory);
  });

  it("leaves ordinary runs unmetered and accumulates distinct original attempts across versions", () => {
    withStore((store) => {
      store.runs.createRun({ id: "ordinary", sessionId: "s1" });
      expect(store.goals.beginGoalModelAttempt({ ...start, runId: "ordinary" })).toEqual({ allowed: true, changed: false });
      expect(store.goals.recordGoalModelAttempt({ ...report(10, 3), runId: "ordinary" })).toEqual({ changed: false });
      store.goals.beginGoalModelAttempt(start);
      store.goals.recordGoalModelAttempt(report(10, 3));
      store.goals.updateGoal("g1", { expectedRevision: 0, objective: "second version" });
      store.runs.createRun({ id: "r2", sessionId: "s1", metadata: { goalId: "g1", goalObjectiveVersion: 2 } });
      store.runs.updateRun("r2", { status: "running" });
      for (const attempt of [1, 2]) {
        store.goals.beginGoalModelAttempt({ ...start, runId: "r2", attempt });
        store.goals.recordGoalModelAttempt({ ...report(4, 1), runId: "r2", attempt });
      }
      expect(store.goals.getGoal("g1")).toMatchObject({ objectiveVersion: 2, revision: 1, usage: { knownTokens: 23, incomplete: false } });
      expect(store.goals.beginGoalModelAttempt({ ...start, generationId: "late-new" })).toMatchObject({ allowed: false });
    });
  });

  it("settles only proven undispatched zero attempts as complete and pauses unknown finite budgets", () => {
    withStore((store) => {
      store.goals.updateGoal("g1", { expectedRevision: 0, tokenBudget: 100 });
      store.goals.beginGoalModelAttempt(start);
      store.goals.recordGoalModelAttempt({ ...key, status: "failed", usageStatus: "unknown", notDispatched: true });
      expect(store.goals.getGoal("g1")).toMatchObject({ status: "active", usage: { knownTokens: 0, incomplete: false, inFlightAttempts: 0 } });
      const next = { ...start, attempt: 2 };
      store.goals.beginGoalModelAttempt(next);
      expect(store.goals.recordGoalModelAttempt({ ...next, status: "interrupted", usageStatus: "unknown" })).toMatchObject({ budgetClosed: true });
      expect(store.goals.getGoal("g1")).toMatchObject({ status: "paused", stopReason: { code: "usage_unknown" }, usage: { unknownAttempts: 1, incomplete: true } });
      expect(store.goals.checkGoalBudget("g1")).toEqual({ code: "usage_unknown" });
      const paused = store.goals.getGoal("g1")!;
      store.goals.updateGoal("g1", { expectedRevision: paused.revision, tokenBudget: null });
      expect(store.goals.getGoal("g1")!.tokenBudget).toBeUndefined();
      expect(store.goals.getGoal("g1")!.status).toBe("paused");
      expect(store.goals.checkGoalBudget("g1")).toEqual({});
    });
  });

  it("registers new bound attempts only during running or completed source memory maintenance", () => {
    withStore((store) => {
      store.runs.createRun({ id: "pending", sessionId: "s1", metadata: { goalId: "g1", goalObjectiveVersion: 1 } });
      expect(store.goals.beginGoalModelAttempt({ ...start, runId: "pending" })).toMatchObject({ allowed: false, changed: false });
      store.runs.updateRun("r1", { status: "completed" });
      for (const purpose of ["generation", "compaction", "finalization"] as const)
        expect(store.goals.beginGoalModelAttempt({ ...start, generationId: purpose, purpose })).toMatchObject({ allowed: false, changed: false });
      expect(store.goals.beginGoalModelAttempt({ ...start, purpose: "memory" })).toMatchObject({ allowed: true, changed: true });
      store.runs.updateRun("pending", { status: "interrupted" });
      expect(store.goals.beginGoalModelAttempt({ ...start, runId: "pending", purpose: "memory" })).toMatchObject({ allowed: false, changed: false });
    });
  });

  it("keeps process-local memory Goal attempts out of startup reconciliation", () => {
    withStore((store, storage) => {
      store.goals.beginGoalModelAttempt(start);
      delete storage.state.runs.r1;
      const before = store.goals.getGoal("g1")!.usage;
      expect(store.goals.reconcileGoalModelAttempts()).toBe(0);
      expect(store.goals.getGoal("g1")!.usage).toEqual(before);
    }, true);
  });

  it("stores a budget and pauses an incomplete active Goal with one revision, preserving user pauses on late reports", () => {
    withStore((store) => {
      store.goals.beginGoalModelAttempt(start);
      store.goals.recordGoalModelAttempt(report(8, 2, "partial"));
      expect(store.goals.getGoal("g1")!.status).toBe("active");
      store.goals.updateGoal("g1", { expectedRevision: 0, tokenBudget: 100 });
      expect(store.goals.getGoal("g1")).toMatchObject({ revision: 1, objectiveVersion: 1, status: "paused", stopReason: { code: "usage_unknown" } });
      store.goals.updateGoal("g1", { expectedRevision: 1, stopReason: { code: "user_paused", at: 10 }, reason: "user paused" });
      expect(store.goals.recordGoalModelAttempt(report(100, 3)).budgetClosed).toBeUndefined();
      expect(store.goals.getGoal("g1")).toMatchObject({ revision: 2, status: "paused", stopReason: { code: "user_paused" }, usage: { knownTokens: 103, incomplete: false } });
    });
  });
  it("counts each attempt once, keeps pending separate, and accepts late complete correction", () => {
    withStore((store) => {
      const revision = store.goals.getGoal("g1")!.revision;
      expect(store.goals.beginGoalModelAttempt(start)).toMatchObject({ allowed: true, changed: true });
      expect(store.goals.getGoal("g1")!.usage).toMatchObject({ knownTokens: 0, incomplete: false, inFlightAttempts: 1, seq: 1 });
      store.goals.recordGoalModelAttempt(report(8, 2, "partial"));
      const once = store.goals.getGoal("g1")!.usage;
      store.goals.recordGoalModelAttempt(report(8, 2, "partial"));
      expect(store.goals.getGoal("g1")!.usage).toEqual(once);
      store.goals.updateGoal("g1", { expectedRevision: revision, objective: "new", status: "completed" });
      store.runs.updateRun("r1", { status: "completed" });
      store.goals.recordGoalModelAttempt(report(10, 3));
      const complete = store.goals.getGoal("g1")!;
      expect(complete).toMatchObject({ status: "completed", objectiveVersion: 2, revision: 1,
        usage: { knownTokens: 13, incomplete: false, partialAttempts: 0, inFlightAttempts: 0, seq: 3 } });
      expect(store.goals.beginGoalModelAttempt(start)).toMatchObject({ changed: false });
      store.goals.recordGoalModelAttempt(report(8, 2, "partial"));
      expect(store.goals.getGoal("g1")!.usage).toEqual(complete.usage);
      const event = store.conversations.listEvents().filter(event => event.type === "session.goal.usage.updated").at(-1)!;
      expect(event.sessionId).toBe("s1");
      expect(event.payload).toEqual({ goalId: "g1", usage: complete.usage });
    });
  });

  it("retains maxima and unresolved contradictory complete reports until fully corrected", () => {
    withStore((store) => {
      store.goals.beginGoalModelAttempt(start);
      store.goals.recordGoalModelAttempt(report(10, 3));
      store.goals.recordGoalModelAttempt(report(9, 5));
      expect(store.goals.getGoal("g1")!.usage).toMatchObject({ knownTokens: 15, incomplete: true });
      store.goals.recordGoalModelAttempt(report(9, 6, "partial"));
      expect(store.goals.getGoal("g1")!.usage.knownTokens).toBe(15);
      store.goals.recordGoalModelAttempt(report(10, 6));
      expect(store.goals.getGoal("g1")!.usage).toMatchObject({ knownTokens: 16, incomplete: false });
    });
  });

  it("keeps a safe monotonic subtotal when the aggregate exceeds exact integer precision", () => {
    withStore((store) => {
      store.goals.beginGoalModelAttempt(start);
      store.goals.recordGoalModelAttempt(report(10, 0));
      store.goals.beginGoalModelAttempt({ ...start, attempt: 2 });
      store.goals.recordGoalModelAttempt({ ...report(Number.MAX_SAFE_INTEGER - 15, 0), attempt: 2 });
      expect(store.goals.getGoal("g1")!.usage.knownTokens).toBe(Number.MAX_SAFE_INTEGER - 5);
      store.goals.recordGoalModelAttempt(report(20, 0));
      expect(store.goals.getGoal("g1")!.usage).toMatchObject({ knownTokens: Number.MAX_SAFE_INTEGER, incomplete: true });
    });
  });

  it("closes active budget and cancels continuations in the report transaction, while pending is allowed", () => {
    withStore((store) => {
      store.goals.updateGoal("g1", { expectedRevision: 0, tokenBudget: 12 });
      store.goals.recordGoalContinuation({ goalId: "g1", revision: 1, previousRunId: "r1", inputId: "i2", runId: "r2" });
      expect(store.goals.beginGoalModelAttempt(start)).toMatchObject({ allowed: true });
      expect(store.goals.getGoal("g1")!.status).toBe("active");
      expect(store.goals.recordGoalModelAttempt(report(10, 3))).toMatchObject({ budgetClosed: true });
      expect(store.goals.getGoal("g1")).toMatchObject({ status: "paused", stopReason: { code: "token_budget" }, usage: { knownTokens: 13 } });
      expect(store.goals.findGoalContinuation("r2")!.status).toBe("cancelled");
      expect(store.goals.beginGoalModelAttempt({ ...start, generationId: "new" })).toMatchObject({ allowed: false, changed: false });
    });
  });

  it("rolls durable ledger rows and sequence back when the usage event cannot be saved", () => {
    withStore((store, storage) => {
      const before = store.goals.getGoal("g1")!.usage;
      storage.database.connection.exec("CREATE TRIGGER fail_usage BEFORE INSERT ON session_event WHEN NEW.type = 'session.goal.usage.updated' BEGIN SELECT RAISE(ABORT, 'usage event failed'); END;");
      expect(() => store.goals.beginGoalModelAttempt(start)).toThrow("usage event failed");
      expect(store.goals.getGoal("g1")!.usage).toEqual(before);
      expect(storage.database.connection.prepare("SELECT count(*) count FROM session_goal_model_attempt").get()).toEqual({ count: 0 });
    });
  });

  it("rolls back a report, its budget pause, and continuation cancellation when the status event fails", () => {
    withStore((store, storage) => {
      store.goals.updateGoal("g1", { expectedRevision: 0, tokenBudget: 12 });
      store.goals.recordGoalContinuation({ goalId: "g1", revision: 1, previousRunId: "r1", inputId: "i2", runId: "r2" });
      store.goals.beginGoalModelAttempt(start);
      const before = store.goals.getGoal("g1")!;
      storage.database.connection.exec("CREATE TRIGGER fail_pause BEFORE INSERT ON session_event WHEN NEW.type = 'session.goal.updated' BEGIN SELECT RAISE(ABORT, 'pause event failed'); END;");
      expect(() => store.goals.recordGoalModelAttempt(report(10, 3))).toThrow("pause event failed");
      expect(store.goals.getGoal("g1")).toEqual(before);
      expect(store.goals.findGoalContinuation("r2")!.status).toBe("pending");
      expect(storage.database.connection.prepare("SELECT state, known_input_tokens FROM session_goal_model_attempt").get()).toEqual({ state: "pending", known_input_tokens: 0 });
    });
  });

  it("keeps memory Goal attempts out of SQLite even from durable Child sessions, and journals deletion", () => {
    withStore((store, storage) => {
      store.sessions.create({ id: "child", cwd: process.cwd(), model: "m" });
      store.runs.createRun({ id: "child-run", sessionId: "child", metadata: { goalId: "g1", goalObjectiveVersion: 1, parentRunId: "r1" } });
      store.runs.updateRun("child-run", { status: "running" });
      const childStart = { ...start, runId: "child-run", sessionId: "child" };
      store.goals.beginGoalModelAttempt(childStart);
      const before = storage.temporaryControls!.snapshot();
      expect(() => store.transaction(() => { store.goals.recordGoalModelAttempt({ ...report(10, 3), ...childStart }); throw new Error("rollback"); })).toThrow("rollback");
      expect(storage.temporaryControls!.snapshot()).toEqual(before);
      storage.temporaryControls!.deleteSession("child");
      expect(store.goals.getGoal("g1")!.usage.inFlightAttempts).toBe(1);
      store.goals.recordGoalModelAttempt({ ...report(10, 3), ...childStart });
      expect(storage.database.connection.prepare("SELECT count(*) count FROM session_goal_model_attempt").get()).toEqual({ count: 0 });
      expect(() => store.transaction(() => { storage.temporaryControls!.deleteSession("s1"); throw new Error("rollback deletion"); })).toThrow("rollback deletion");
      expect(store.goals.getGoal("g1")!.usage.knownTokens).toBe(13);
      storage.temporaryControls!.deleteSession("s1");
      expect(storage.temporaryControls!.goalModelAttempts.size).toBe(0);
    }, true);
  });

  it("keeps frozen dispatch identity after durable Child deletion and rejects unregistered or forged reports", () => {
    withStore((store, storage) => {
      store.sessions.create({ id: "child", cwd: process.cwd(), model: "m" });
      store.runs.createRun({ id: "child-run", sessionId: "child", metadata: { goalId: "g1", goalObjectiveVersion: 1, parentRunId: "r1" } });
      store.runs.updateRun("child-run", { status: "running" });
      const child = { ...start, runId: "child-run", sessionId: "child" };
      store.goals.beginGoalModelAttempt(child);
      storage.database.connection.prepare("DELETE FROM session WHERE id = ?").run("child");
      delete storage.state.runs["child-run"];
      expect(store.goals.recordGoalModelAttempt({ ...report(4, 2), ...child })).toMatchObject({ changed: true });
      expect(store.goals.getGoal("g1")!.usage.knownTokens).toBe(6);
      expect(() => store.goals.recordGoalModelAttempt(report(1, 1))).toThrow();
      expect(() => store.goals.recordGoalModelAttempt({ ...report(4, 2), ...child, sessionId: "s1" })).toThrow();
      expect(() => store.goals.beginGoalModelAttempt({ ...child, model: "different" })).toThrow();
    });
  });

  it("reconciles abandoned pending reports and root runtime across all objective versions without Child double count", () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
    withStore((store) => {
      store.goals.beginGoalModelAttempt(start);
      store.runs.updateRun("r1", { status: "running" });
      clock.mockReturnValue(5_000);
      store.runs.updateRun("r1", { status: "interrupted" });
      store.runs.createRun({ id: "r2", sessionId: "s1", metadata: { goalId: "g1", goalObjectiveVersion: 2 } });
      store.runs.updateRun("r2", { status: "running" });
      store.runs.createRun({ id: "child", sessionId: "s1", metadata: { goalId: "g1", goalObjectiveVersion: 1, parentRunId: "r1" } });
      store.runs.updateRun("child", { status: "running" });
      clock.mockReturnValue(7_000);
      store.runs.updateRun("r2", { status: "completed" });
      store.runs.updateRun("child", { status: "completed" });
      expect(store.goals.reconcileGoalModelAttempts()).toBe(1);
      expect(store.goals.getGoal("g1")!.usage).toMatchObject({ knownTokens: 0, unknownAttempts: 1, incomplete: true, runTimeMs: 6_000 });
      const once = store.goals.refreshGoalRunTime("g1");
      expect(store.goals.refreshGoalRunTime("g1")).toEqual(once);
      store.goals.recordGoalModelAttempt(report(0, 0));
      expect(store.goals.getGoal("g1")!.usage.incomplete).toBe(false);
    });
  });
});

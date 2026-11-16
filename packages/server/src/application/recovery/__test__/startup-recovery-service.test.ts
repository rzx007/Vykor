import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "@vykor/services";
import { afterEach, describe, expect, it } from "vitest";
import { StartupRecoveryService } from "../startup-recovery-service.js";

const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).forEach((dispose) => dispose()));

describe("StartupRecoveryService", () => {
  it("runs durable SQLite recovery in order and remains idempotent", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vk-startup-recovery-"));
    const databasePath = join(directory, "store.db");
    let store = new SessionStore({ path: databasePath });
    cleanup.push(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
    store.sessions.create({ id: "s1", cwd: directory, model: "test" });
    for (const id of ["applied", "admitted", "promoting"]) {
      store.conversationTransactions.admitPrompt({
        id, sessionId: "s1", content: id,
        delivery: id === "promoting" ? "queue" : "steer",
        metadata: id === "promoting" ? {} : { steerTargetRunId: "r1" },
      });
    }
    store.runs.createRun({ id: "r1", sessionId: "s1", status: "running",
      metadata: { appliedInputState: { revision: 2, inputIds: ["root", "applied"] } } });
    store.runs.createRun({ id: "reserved", sessionId: "s1", inputId: "promoting",
      metadata: { promotion: { kind: "steering", activeRunId: "r1", inputId: "promoting" } } });
    const temporary = store.sessions.create({ cwd: directory, model: "test", storage: "memory" });
    // Drop the original owner's in-memory state before running startup recovery.
    store.close();
    store = new SessionStore({ path: databasePath });
    const order: string[] = [];
    const recovery = new StartupRecoveryService({
      recoverProjectionSettlements: () => { order.push("projection"); },
      recoverPluginUiActions: () => { order.push("ui-actions"); },
      interruptActiveRuns: () => { order.push("runs"); store.interruptActiveRuns("restart"); },
      reconcileGoalModelAttempts: () => { order.push("usage"); store.goals.reconcileGoalModelAttempts(); },
      pauseActiveGoals: () => { order.push("goals"); store.goals.pauseActiveGoalsOnStartup(); },
      terminalizeUnownedInputs: () => { order.push("inputs"); store.terminalizeUnownedInputs("restart"); },
      expirePendingPermissions: () => { order.push("permissions"); store.permissions.expirePending("restart"); },
      finalizeClosingSessions: () => { order.push("sessions"); store.finalizeClosingSessions(); },
      recoverAttachments: async () => { order.push("attachments"); },
      reconcileBackgroundTasks: async () => { order.push("background"); },
      recoverGoalWaits: () => { order.push("goal-waits"); },
      recoverWorkflows: async () => { order.push("workflows"); },
    });
    await recovery.run();
    store.close();
    store = new SessionStore({ path: databasePath });
    expect(store.runs.getRun("r1")).toMatchObject({
      status: "interrupted", metadata: { appliedInputState: { revision: 2, inputIds: ["root", "applied"] } },
    });
    expect(store.runs.findRunByInput("applied")).toBeUndefined();
    expect(store.runs.findRunByInput("admitted")).toMatchObject({ status: "interrupted" });
    expect(store.runs.getRun("reserved")).toMatchObject({ status: "interrupted", metadata: { promotion: { kind: "failed" } } });
    expect(store.sessions.get(temporary.id)).toBeUndefined();
    await recovery.run();
    expect(store.runs.getRun("r1")?.status).toBe("interrupted");
    expect(order.slice(0, 8)).toEqual(["projection", "ui-actions", "runs", "usage", "goals", "inputs", "permissions", "sessions"]);
    expect(order.filter((entry) => entry === "workflows")).toHaveLength(2);
    expect(order.filter((entry) => entry === "goal-waits")).toHaveLength(2);
  });

  it("converges incomplete auto reviews right after interrupting active runs", async () => {
    const order: string[] = [];
    const recovery = new StartupRecoveryService({
      recoverProjectionSettlements: () => { order.push("projection"); },
      interruptActiveRuns: () => { order.push("runs"); },
      failIncompleteReviewsOnStartup: () => { order.push("reviews"); return 2; },
      pauseActiveGoals: () => { order.push("goals"); },
      terminalizeUnownedInputs: () => {},
      expirePendingPermissions: () => {},
      finalizeClosingSessions: () => {},
      recoverAttachments: async () => {},
      reconcileBackgroundTasks: async () => {},
      recoverGoalWaits: () => {},
      recoverWorkflows: async () => {},
    });
    await recovery.run();
    expect(order.slice(0, 3)).toEqual(["projection", "runs", "reviews"]);
  });

  it("rejects immediately when a required recovery step fails", async () => {
    const recovery = new StartupRecoveryService({
      recoverProjectionSettlements: () => { throw new Error("projection failed"); },
      interruptActiveRuns: () => {}, pauseActiveGoals: () => {}, terminalizeUnownedInputs: () => {},
      expirePendingPermissions: () => {}, finalizeClosingSessions: () => {},
      recoverAttachments: async () => {}, reconcileBackgroundTasks: async () => {}, recoverGoalWaits: () => {}, recoverWorkflows: async () => {},
    });
    await expect(recovery.run()).rejects.toThrow("projection failed");
  });

  it.each(["attachments", "background", "workflows"] as const)("propagates async %s recovery failure", async (failed) => {
    const step = (name: typeof failed) => async () => {
      if (name === failed) throw new Error(`${name} failed`);
    };
    const recovery = new StartupRecoveryService({
      recoverProjectionSettlements: () => {}, interruptActiveRuns: () => {}, pauseActiveGoals: () => {},
      terminalizeUnownedInputs: () => {}, expirePendingPermissions: () => {}, finalizeClosingSessions: () => {},
      recoverAttachments: step("attachments"), reconcileBackgroundTasks: step("background"), recoverGoalWaits: () => {}, recoverWorkflows: step("workflows"),
    });
    await expect(recovery.run()).rejects.toThrow(`${failed} failed`);
  });
});

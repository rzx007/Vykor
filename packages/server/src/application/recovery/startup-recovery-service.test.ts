import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "@vykor/services";
import { afterEach, describe, expect, it } from "vitest";
import { StartupRecoveryService } from "./startup-recovery-service.js";

const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).forEach((dispose) => dispose()));

describe("StartupRecoveryService", () => {
  it("runs durable SQLite recovery in order and remains idempotent", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vk-startup-recovery-"));
    const databasePath = join(directory, "store.db");
    let store = new SessionStore({ path: databasePath });
    cleanup.push(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
    store.sessions.create({ id: "s1", cwd: directory, model: "test" });
    store.runs.createRun({ id: "r1", sessionId: "s1", status: "running" });
    const order: string[] = [];
    const recovery = new StartupRecoveryService({
      recoverProjectionSettlements: () => { order.push("projection"); },
      interruptActiveRuns: () => { order.push("runs"); store.interruptActiveRuns("restart"); },
      pauseActiveGoals: () => { order.push("goals"); store.goals.pauseActiveGoalsOnStartup(); },
      terminalizeUnownedInputs: () => { order.push("inputs"); store.terminalizeUnownedInputs("restart"); },
      expirePendingPermissions: () => { order.push("permissions"); store.permissions.expirePending("restart"); },
      finalizeClosingSessions: () => { order.push("sessions"); store.finalizeClosingSessions(); },
      recoverAttachments: async () => { order.push("attachments"); },
      reconcileBackgroundTasks: async () => { order.push("background"); },
      recoverWorkflows: async () => { order.push("workflows"); },
    });
    await recovery.run();
    store.close();
    store = new SessionStore({ path: databasePath });
    expect(store.runs.getRun("r1")?.status).toBe("interrupted");
    await recovery.run();
    expect(store.runs.getRun("r1")?.status).toBe("interrupted");
    expect(order.slice(0, 6)).toEqual(["projection", "runs", "goals", "inputs", "permissions", "sessions"]);
    expect(order.filter((entry) => entry === "workflows")).toHaveLength(2);
  });

  it("rejects immediately when a required recovery step fails", async () => {
    const recovery = new StartupRecoveryService({
      recoverProjectionSettlements: () => { throw new Error("projection failed"); },
      interruptActiveRuns: () => {}, pauseActiveGoals: () => {}, terminalizeUnownedInputs: () => {},
      expirePendingPermissions: () => {}, finalizeClosingSessions: () => {},
      recoverAttachments: async () => {}, reconcileBackgroundTasks: async () => {}, recoverWorkflows: async () => {},
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
      recoverAttachments: step("attachments"), reconcileBackgroundTasks: step("background"), recoverWorkflows: step("workflows"),
    });
    await expect(recovery.run()).rejects.toThrow(`${failed} failed`);
  });
});

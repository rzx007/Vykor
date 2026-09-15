import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "@openharness/services";
import { afterEach, describe, expect, it } from "vitest";
import { StartupRecoveryService } from "./startup-recovery-service.js";

const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).forEach((dispose) => dispose()));

describe("StartupRecoveryService", () => {
  it("runs durable SQLite recovery in order and remains idempotent", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ohs-startup-recovery-"));
    const store = new SessionStore({ path: join(directory, "store.db") });
    cleanup.push(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
    store.createSession({ id: "s1", cwd: directory, model: "test" });
    store.createRun({ id: "r1", sessionId: "s1", status: "running" });
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
    await recovery.run();
    expect(store.getRun("r1")?.status).toBe("interrupted");
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
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "@openharness/services";
import { createWorkflowPlan, createWorkflowRunSnapshot } from "@openharness/coordinator";
import { describe, expect, it, vi } from "vitest";

import { DaemonControlService } from "../daemon-control-service.js";
import { DaemonOperationGate } from "../daemon-operation-gate.js";
import { DaemonApplication } from "../../daemon-application.js";

function createControl() {
  const sessions = [
    { id: "s1", status: "idle" },
    { id: "s2", status: "archived" },
  ];
  const store = {
    listSessions: vi.fn(() => sessions),
    listRuns: vi.fn((sessionId) => sessionId === "s1" ? [{ status: "running" }] : []),
    listSessionTasks: vi.fn(() => []),
    permissions: { list: vi.fn(() => [{ status: "pending" }]) },
    listProjectionSettlements: vi.fn(() => [
      { status: "pending" },
      { status: "resolved" },
    ]),
    getSession: vi.fn((sessionId) => sessions.find((session) => session.id === sessionId)),
  };
  const runEngine = {
    activeRunId: vi.fn((sessionId) => sessionId === "s1" ? "run-1" : undefined),
    queuedRunIds: vi.fn((sessionId) => sessionId === "s1" ? ["run-2"] : []),
    hasAnyActiveRuns: vi.fn(() => true),
    hasActiveRunsForCwd: vi.fn(() => false),
    stopAndDrain: vi.fn(async () => {}),
  };
  const agent = { inspect: vi.fn(() => ({ hooks: [{ id: "hook-1", event: "pre_tool_use", type: "command", enabled: true }] })) };
  const agentPool = {
    configured: true,
    size: 1,
    acquireSession: vi.fn(async () => agent),
    hasActiveWork: vi.fn(() => false),
    hasActiveWorkForCwd: vi.fn(() => false),
    closeAll: vi.fn(async () => {}),
    closeForCwd: vi.fn(async () => {}),
    invalidateWarmAgents: vi.fn(async () => {}),
  };
  const operationGate = new DaemonOperationGate();
  const control = new DaemonControlService({
    store: store as any,
    permissions: store.permissions,
    workflows: { listRuns: () => [{ runId: "workflow-1", status: "running", snapshotJson: "{}", createdAt: 1, updatedAt: 2 }] },
    runEngine: runEngine as any,
    agentPool: agentPool as any,
    operationGate,
    startedAt: Date.now() - 100,
    sseClientCount: () => 2,
  });
  return { control, store, runEngine, agentPool, operationGate };
}

describe("DaemonControlService", () => {
  it("uses the composed run lifecycle to stop admission before draining control", async () => {
    const { store, runEngine, agentPool, operationGate } = createControl();
    const runControl = {
      activeRunId: vi.fn(), queuedRunIds: vi.fn(() => []),
      hasAnyActiveRuns: vi.fn(() => false), hasActiveRunsForCwd: vi.fn(() => false),
      stopAndDrain: vi.fn(async () => {}),
    };
    const control = new DaemonControlService({
      store: store as any,
      permissions: store.permissions,
      workflows: { listRuns: () => [] },
      runEngine: runEngine as any,
      runControl,
      agentPool: agentPool as any,
      operationGate,
      startedAt: Date.now(),
      sseClientCount: () => 0,
    });

    await control.shutdown();

    expect(runEngine.stopAndDrain).toHaveBeenCalledOnce();
    expect(runControl.stopAndDrain).not.toHaveBeenCalled();
  });
  it("uses the Workflow queries supplied by daemon composition for snapshots and run inspection", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ohs-control-workflows-"));
    const store = new SessionStore({ path: join(directory, "sessions.db") });
    const application = new DaemonApplication({
      store,
      settings: {
        apiFormat: "anthropic", model: "test-model", maxTurns: 1,
        permission: { mode: "full_auto" }, sandbox: { enabled: false }, memory: { enabled: false },
      },
      log: () => undefined,
    });
    const workflows = store.workflows;
    try {
      const composed = application as unknown as { runEngine: { admission: unknown; control: unknown } };
      expect(application.runAdmission).toBe(composed.runEngine.admission);
      expect(application.runControl).toBe(composed.runEngine.control);
      store.createSession({ id: "s1", cwd: directory, model: "test" });
      store.createRun({ id: "r1", sessionId: "s1" });
      const spec = { mode: "sequential" as const, tasks: [{ id: "one" }] };
      application.workflows.save(createWorkflowRunSnapshot({
        runId: "workflow-1", ownerRun: "r1", status: "completed", summary: "done",
        spec, plan: createWorkflowPlan(spec), results: new Map(), running: new Set(), createdAt: 1,
      }));
      Object.defineProperty(store, "workflows", {
        configurable: true,
        get: () => { throw new Error("Control must use its injected Workflow queries"); },
      });

      expect(application.control.runtimeSnapshot().workflows).toEqual({ total: 1, byStatus: { completed: 1 } });
      expect(application.control.inspectRun("r1")?.workflows).toMatchObject([{ runId: "workflow-1", ownerRunId: "r1" }]);
    } finally {
      Object.defineProperty(store, "workflows", { configurable: true, value: workflows });
      await application.close();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("builds the daemon runtime snapshot from authoritative owners", () => {
    const { control } = createControl();

    const snapshot = control.runtimeSnapshot();

    expect(snapshot).toMatchObject({
      sessions: { total: 2, byStatus: { idle: 1, archived: 1 } },
      runs: { total: 1, byStatus: { running: 1 } },
      workflows: { total: 1, byStatus: { running: 1 } },
      permissions: { total: 1, byStatus: { pending: 1 } },
      projectionSettlements: {
        total: 2,
        pending: 1,
        byStatus: { pending: 1, resolved: 1 },
      },
      sseClientCount: 2,
      warmAgentCount: 1,
      coordinator: { activeRunCount: 1, queuedRunCount: 1 },
    });
  });

  it("inspects hooks through the shared runtime pool", async () => {
    const { control, agentPool } = createControl();

    await expect(control.inspectRuntimeHooks("s1")).resolves.toEqual([
      { id: "hook-1", event: "pre_tool_use", type: "command", enabled: true, origin: "runtime" },
    ]);
    expect(agentPool.acquireSession).toHaveBeenCalledWith("s1");
  });

  it("invalidates warm agents without requiring a global mutation lease", async () => {
    const { control, agentPool } = createControl();

    await control.invalidateRuntimes();

    expect(agentPool.invalidateWarmAgents).toHaveBeenCalledOnce();
  });

  it("closes agents and seals admission even when run draining fails", async () => {
    const { control, runEngine, agentPool, operationGate } = createControl();
    runEngine.stopAndDrain.mockRejectedValueOnce(new Error("drain failed"));

    await expect(control.shutdown()).rejects.toThrow("drain failed");
    expect(agentPool.closeAll).toHaveBeenCalledOnce();
    expect(operationGate.accepting).toBe(false);
    expect(() => operationGate.enter({ sessionId: "s1", cwd: "/repo" })).toThrow("Daemon is closing");
  });

  it("aggregates drain and pool failures after sealing the operation gate", async () => {
    const { control, runEngine, agentPool, operationGate } = createControl();
    const drainError = new Error("drain failed");
    const poolError = new Error("pool close failed");
    runEngine.stopAndDrain.mockRejectedValueOnce(drainError);
    agentPool.closeAll.mockRejectedValueOnce(poolError);

    const failure = await control.shutdown().catch((error) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([drainError, poolError]);
    expect(runEngine.stopAndDrain).toHaveBeenCalledOnce();
    expect(agentPool.closeAll).toHaveBeenCalledOnce();
    expect(operationGate.accepting).toBe(false);
    expect(() => operationGate.enter({ sessionId: "s1", cwd: "/repo" })).toThrow("Daemon is closing");
  });
});

import { describe, expect, it, vi } from "vitest";

import { DaemonControlService } from "../daemon-control-service.js";
import { DaemonOperationGate } from "../daemon-operation-gate.js";

function createControl() {
  const sessions = [
    { id: "s1", status: "idle" },
    { id: "s2", status: "archived" },
  ];
  const store = {
    workflows: { listRuns: vi.fn(() => []) },
    listSessions: vi.fn(() => sessions),
    listRuns: vi.fn((sessionId) => sessionId === "s1" ? [{ status: "running" }] : []),
    listSessionTasks: vi.fn(() => []),
    listPermissionRequests: vi.fn(() => [{ status: "pending" }]),
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
    runEngine: runEngine as any,
    agentPool: agentPool as any,
    operationGate,
    startedAt: Date.now() - 100,
    sseClientCount: () => 2,
  });
  return { control, store, runEngine, agentPool, operationGate };
}

describe("DaemonControlService", () => {
  it("builds the daemon runtime snapshot from authoritative owners", () => {
    const { control } = createControl();

    const snapshot = control.runtimeSnapshot();

    expect(snapshot).toMatchObject({
      sessions: { total: 2, byStatus: { idle: 1, archived: 1 } },
      runs: { total: 1, byStatus: { running: 1 } },
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

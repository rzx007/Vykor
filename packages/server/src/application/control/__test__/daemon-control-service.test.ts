import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "@vykor/services";
import { createWorkflowPlan, createWorkflowRunSnapshot } from "@vykor/coordinator";
import { describe, expect, it, vi } from "vitest";

import { DaemonControlService } from "../daemon-control-service.js";
import { DaemonOperationGate } from "../daemon-operation-gate.js";
import { DaemonApplication } from "../../daemon-application.js";
import { SessionEventPublisher } from "../../session/session-event-publisher.js";
import { SessionOperationRunner } from "../../session/session-operation-runner.js";
import { assembleSessionRunServices } from "../../session/session-run-assembly.js";

function createControl() {
  const sessions = [
    { id: "s1", status: "idle" },
    { id: "s2", status: "archived" },
  ];
  const store = {
    sessions: {
      list: vi.fn(() => sessions),
      get: vi.fn((sessionId) => sessions.find((session) => session.id === sessionId)),
    },
    runs: {
      listRuns: vi.fn((sessionId) => sessionId === "s1" ? [{ status: "running" }] : []),
      listRunAttempts: vi.fn(() => []),
    },
    conversations: { listMessageParts: vi.fn(() => []) },
    listSessionTasks: vi.fn(() => []),
    permissions: { list: vi.fn(() => [{ status: "pending" }]) },
    listProjectionSettlements: vi.fn(() => [
      { status: "pending" },
      { status: "resolved" },
    ]),
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
  const executionObservations = {
    query: vi.fn(() => ({
      schemaVersion: 1 as const,
      generatedAt: 0,
      filters: {},
      summary: {},
      records: [],
      warnings: [],
    })),
  };
  const control = new DaemonControlService({
    store: store as any,
    permissions: store.permissions,
    workflows: { listRuns: () => [{ runId: "workflow-1", status: "running", snapshotJson: "{}", createdAt: 1, updatedAt: 2 }] },
    executionObservations,
    runControl: runEngine as any,
    agentPool: agentPool as any,
    operationGate,
    startedAt: Date.now() - 100,
    sseClientCount: () => 2,
  });
  return { control, store, runEngine, agentPool, operationGate, executionObservations };
}

describe("DaemonControlService", () => {
  it("cancels a normal run admitted after the initial shutdown cancellation scan", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vk-shutdown-late-admission-"));
    const store = new SessionStore({ path: join(directory, "sessions.db") });
    const session = store.sessions.create({ cwd: directory, model: "test" });
    const operationGate = new DaemonOperationGate();
    const events = new SessionEventPublisher(store.conversations, {
      broadcastSince: () => undefined, broadcastEvent: () => undefined,
    });
    let materializing!: () => void;
    const materializationStarted = new Promise<void>(resolve => { materializing = resolve; });
    let finishMaterialization!: (text: string) => void;
    const materialization = new Promise<string>(resolve => { finishMaterialization = resolve; });
    let aborted = false;
    let activeWhenPoolClosed = true;
    const { agentPool, executionObservations } = createControl();
    const services = assembleSessionRunServices({
      store, goals: store.goals, agentPool: agentPool as never, events,
      assertReady: () => undefined,
      materializeSteerInput: async () => { materializing(); return await materialization; },
      settleGoalRun: async () => undefined,
      runExecutor: {
        execute: async (input, context) => {
          store.runs.updateRun(input.runId, { status: "running" });
          await new Promise<void>(resolve => {
            const cancel = () => { aborted = true; resolve(); };
            if (context.signal.aborted) cancel();
            else context.signal.addEventListener("abort", cancel, { once: true });
          });
          store.runs.updateRun(input.runId, { status: "interrupted" });
        },
      },
    });
    agentPool.closeAll.mockImplementation(async () => {
      activeWhenPoolClosed = services.control.hasAnyActiveRuns();
    });
    const control = new DaemonControlService({
      store, permissions: store.permissions, workflows: store.workflows,
      executionObservations, runControl: services.control, agentPool: agentPool as never,
      operationGate, startedAt: Date.now(), sseClientCount: () => 0,
    });
    const runner = new SessionOperationRunner({ sessions: store.sessions, operationGate, events });
    // Observe the actual first drain to reproduce the empty cancellation snapshot deterministically.
    const drain = vi.spyOn(services.control, "stopAndDrain");
    const admission = runner.run(session.id, () => services.admission.admitPromptAndMaybeRun(session.id, {
      id: "late-skill-input", delivery: "steer",
      items: [{ type: "skill", name: "review", path: join(directory, "SKILL.md") }],
    }));
    let shutdown: Promise<void> | undefined;
    let storeClosed = false;
    try {
      await materializationStarted;
      shutdown = control.shutdown();
      await drain.mock.results[0]!.value;
      expect(operationGate.accepting).toBe(false);
      finishMaterialization("prepared skill");
      const admitted = await admission;
      await shutdown;
      expect(activeWhenPoolClosed).toBe(false);
      expect(services.engine.runtimeBridge.activeRunId(session.id)).toBeUndefined();
      expect(aborted).toBe(true);
      expect(store.runs.getRun(admitted.run!.id)?.status).toBe("interrupted");
      store.close();
      storeClosed = true;
      const reopened = new SessionStore({ path: join(directory, "sessions.db") });
      try {
        expect(reopened.runs.getRun(admitted.run!.id)?.status).toBe("interrupted");
      } finally { reopened.close(); }
    } finally {
      finishMaterialization("cleanup");
      await admission.catch(() => undefined);
      if (!storeClosed) {
        services.control.interruptSession(session.id, "test cleanup");
        await services.engine.runtimeBridge.waitForRuns(store.runs.listRuns(session.id).map(run => run.id));
      }
      await shutdown;
      drain.mockRestore();
      if (!storeClosed) store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("still closes the pool if cancellation after admission drain fails", async () => {
    const { control, runEngine, agentPool, operationGate } = createControl();
    runEngine.stopAndDrain.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("late drain failed"));
    await expect(control.shutdown()).rejects.toThrow("late drain failed");
    expect(agentPool.closeAll).toHaveBeenCalledOnce();
    expect(operationGate.accepting).toBe(false);
  });

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
      runControl,
      agentPool: agentPool as any,
      operationGate,
      startedAt: Date.now(),
      sseClientCount: () => 0,
    });

    await control.shutdown();

    expect(runEngine.stopAndDrain).not.toHaveBeenCalled();
    expect(runControl.stopAndDrain).toHaveBeenCalledTimes(2);
  });
  it("uses the Workflow queries supplied by daemon composition for snapshots and run inspection", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vk-control-workflows-"));
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
      expect(application.runAdmission).toBeDefined();
      expect(application.runControl).toBeDefined();
      store.sessions.create({ id: "s1", cwd: directory, model: "test" });
      store.runs.createRun({ id: "r1", sessionId: "s1" });
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

  it("forwards execution observation queries to the injected service", () => {
    const { control, executionObservations } = createControl();
    control.queryExecutionObservations({ executionKinds: ["workflow_task"] });
    expect(executionObservations.query).toHaveBeenCalledWith({ executionKinds: ["workflow_task"] });
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
    expect(runEngine.stopAndDrain).toHaveBeenCalledTimes(2);
    expect(agentPool.closeAll).toHaveBeenCalledOnce();
    expect(operationGate.accepting).toBe(false);
    expect(() => operationGate.enter({ sessionId: "s1", cwd: "/repo" })).toThrow("Daemon is closing");
  });
});

import { describe, expect, it, vi } from "vitest";
import type {
  SessionInputRecord,
  SessionMessagePartRecord,
  SessionMessageRecord,
  SessionRunRecord,
} from "@openharness/protocol";
import {
  RunControlService,
  type RunControlServiceOptions,
} from "../run-control-service.js";

function createMockControlOptions() {
  const sessions = new Map<string, any>();
  const runs = new Map<string, SessionRunRecord>();
  const inputs = new Map<string, SessionInputRecord>();
  const messages = new Map<string, SessionMessageRecord[]>();
  const messageParts = new Map<string, SessionMessagePartRecord[]>();

  const activeRuns = new Map<string, string>();
  const queuedRuns = new Map<string, string[]>();

  const options: RunControlServiceOptions = {
    durableSessions: {
      getSession: vi.fn((id: string) => sessions.get(id)),
      listSessions: vi.fn((opts?: any) => {
        return [...sessions.values()].filter((s) => {
          if (opts?.cwd && s.cwd !== opts.cwd) return false;
          if (!opts?.includeArchived && s.status === "archived") return false;
          return true;
        });
      }),
    },
    durableRuns: {
      getRun: vi.fn((id: string) => runs.get(id)),
      updateRun: vi.fn((id: string, update: any) => {
        const run = Object.assign(runs.get(id) ?? {}, update);
        runs.set(id, run);
        return run;
      }),
      listRuns: vi.fn((sessionId: string) =>
        [...runs.values()].filter((r) => r.sessionId === sessionId),
      ),
      appendEvent: vi.fn(),
      transaction: (work) => work(),
    },
    durableInputs: {
      getInput: vi.fn((id: string) => inputs.get(id)),
      listMessages: vi.fn((sessionId: string) => messages.get(sessionId) ?? []),
      listMessageParts: vi.fn((sessionId: string, opts?: any) => {
        const parts = messageParts.get(sessionId) ?? [];
        return opts?.messageId ? parts.filter((p) => p.messageId === opts.messageId) : parts;
      }),
    },
    runtime: {
      activeRunId: vi.fn((sessionId: string) => activeRuns.get(sessionId)),
      queuedRunIds: vi.fn((sessionId: string) => queuedRuns.get(sessionId) ?? []),
      hasWork: vi.fn((sessionId: string) =>
        Boolean(activeRuns.get(sessionId) || (queuedRuns.get(sessionId)?.length ?? 0) > 0),
      ),
      sessionIds: vi.fn(() => [...new Set([...activeRuns.keys(), ...queuedRuns.keys()])]),
      interruptSession: vi.fn((sessionId: string) => {
        const active = activeRuns.get(sessionId);
        const queued = queuedRuns.get(sessionId) ?? [];
        activeRuns.delete(sessionId);
        queuedRuns.delete(sessionId);
        return { activeRunId: active, queuedRunIds: queued, interrupted: Boolean(active || queued.length) };
      }),
      interruptRun: vi.fn((sessionId: string, runId: string) => {
        const active = activeRuns.get(sessionId) === runId ? runId : undefined;
        if (active) activeRuns.delete(sessionId);
        const queued = queuedRuns.get(sessionId) ?? [];
        const remainingQueued = queued.filter((id) => id !== runId);
        queuedRuns.set(sessionId, remainingQueued);
        const wasQueued = queued.includes(runId);
        return {
          activeRunId: active,
          queuedRunIds: wasQueued ? [runId] : [],
          interrupted: Boolean(active || wasQueued),
        };
      }),
      interruptQueuedRun: vi.fn((sessionId: string, runId: string) => {
        const queued = queuedRuns.get(sessionId) ?? [];
        queuedRuns.set(sessionId, queued.filter((id) => id !== runId));
        return { queuedRunIds: queued.includes(runId) ? [runId] : [] };
      }),
      promoteQueuedRun: vi.fn((sessionId: string, queuedRunId: string, expectedActiveRunId: string) => {
        const queued = queuedRuns.get(sessionId) ?? [];
        if (!queued.includes(queuedRunId)) return { promoted: false, delivery: Promise.resolve({} as any) };
        queuedRuns.set(sessionId, queued.filter((id) => id !== queuedRunId));
        return {
          promoted: true,
          delivery: Promise.resolve({ sessionId, inputId: "inp-1", runId: expectedActiveRunId }),
        };
      }),
      waitForRun: vi.fn(async () => {}),
      waitForRuns: vi.fn(async () => {}),
    },
    events: {
      checkpoint: vi.fn(() => 1),
      publishSince: vi.fn(),
    },
  };

  return {
    options,
    sessions,
    runs,
    inputs,
    messages,
    messageParts,
    activeRuns,
    queuedRuns,
  };
}

describe("RunControlService", () => {
  it("queries activeRunId, queuedRunIds and hasWork correctly", () => {
    const { options, activeRuns, queuedRuns } = createMockControlOptions();
    activeRuns.set("s1", "r-active");
    queuedRuns.set("s1", ["r-q1", "r-q2"]);

    const service = new RunControlService(options);

    expect(service.activeRunId("s1")).toBe("r-active");
    expect(service.queuedRunIds("s1")).toEqual(["r-q1", "r-q2"]);
    expect(service.hasWork("s1")).toBe(true);
    expect(service.hasWork("s2")).toBe(false);
  });

  it("checks hasUserWork distinguishing user work from goal continuation runs", () => {
    const { options, runs } = createMockControlOptions();
    runs.set("r1", {
      id: "r1",
      sessionId: "s1",
      status: "running",
      createdAt: 1,
      updatedAt: 1,
      metadata: { goalRunKind: "continuation" },
    });
    const service = new RunControlService(options);

    expect(service.hasUserWork("s1")).toBe(false);

    runs.set("r2", {
      id: "r2",
      sessionId: "s1",
      status: "pending",
      createdAt: 1,
      updatedAt: 1,
      metadata: { goalRunKind: "user" },
    });
    expect(service.hasUserWork("s1")).toBe(true);
  });

  it("checks hasActiveRunsForCwd across sessions matching cwd", () => {
    const { options, sessions, activeRuns } = createMockControlOptions();
    sessions.set("s1", { id: "s1", cwd: "/project/a", status: "open" });
    sessions.set("s2", { id: "s2", cwd: "/project/b", status: "open" });
    activeRuns.set("s1", "r1");

    const service = new RunControlService(options);

    expect(service.hasActiveRunsForCwd("/project/a")).toBe(true);
    expect(service.hasActiveRunsForCwd("/project/b")).toBe(false);
  });

  it("interrupts session, updates queued runs to interrupted, and appends event", () => {
    const { options, runs, activeRuns, queuedRuns } = createMockControlOptions();
    activeRuns.set("s1", "r-act");
    queuedRuns.set("s1", ["r-q1"]);
    runs.set("r-act", { id: "r-act", sessionId: "s1", status: "running", metadata: {}, createdAt: 1, updatedAt: 1 });
    runs.set("r-q1", { id: "r-q1", sessionId: "s1", status: "pending", metadata: {}, createdAt: 1, updatedAt: 1 });

    const service = new RunControlService(options);
    const result = service.interruptSession("s1", "User cancelled");

    expect(result.interrupted).toBe(true);
    expect(options.durableRuns.updateRun).toHaveBeenCalledWith("r-q1", {
      status: "interrupted",
      error: "User cancelled",
    });
    expect(options.durableRuns.appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "session.run.interrupt_requested",
        sessionId: "s1",
        payload: expect.objectContaining({ reason: "User cancelled" }),
      }),
    );
    expect(options.events.publishSince).toHaveBeenCalled();
  });

  it("interrupts single run scoped to targeted runId", () => {
    const { options, runs, activeRuns, queuedRuns } = createMockControlOptions();
    activeRuns.set("s1", "r-act");
    queuedRuns.set("s1", ["r-q1", "r-q2"]);
    runs.set("r-q1", { id: "r-q1", sessionId: "s1", status: "pending", metadata: {}, createdAt: 1, updatedAt: 1 });

    const service = new RunControlService(options);
    const result = service.interruptRun("s1", "r-q1", "Stop q1");

    expect(result.interrupted).toBe(true);
    expect(options.durableRuns.updateRun).toHaveBeenCalledWith("r-q1", {
      status: "interrupted",
      error: "Stop q1",
    });
  });

  it("interrupts queued run specifically", () => {
    const { options, runs, queuedRuns } = createMockControlOptions();
    queuedRuns.set("s1", ["r-q1"]);
    runs.set("r-q1", { id: "r-q1", sessionId: "s1", status: "pending", metadata: {}, createdAt: 1, updatedAt: 1 });

    const service = new RunControlService(options);
    const result = service.interruptQueuedRun("s1", "r-q1", "Cancel queued");

    expect(result.queuedRunIds).toContain("r-q1");
    expect(options.durableRuns.updateRun).toHaveBeenCalledWith("r-q1", {
      status: "interrupted",
      error: "Cancel queued",
    });
  });

  it("cancels goal runs matching goalId", () => {
    const { options, runs, activeRuns, queuedRuns } = createMockControlOptions();
    runs.set("gr1", {
      id: "gr1",
      sessionId: "s1",
      status: "pending",
      metadata: { goalId: "g1", goalRunKind: "continuation" },
      createdAt: 1,
      updatedAt: 1,
    });
    queuedRuns.set("s1", ["gr1"]);
    const markGoalContinuation = vi.fn();
    options.goals = { markGoalContinuation };

    const service = new RunControlService(options);
    const cancelled = service.cancelGoalRuns("s1", "g1", "User cancelled goal");

    expect(cancelled).toEqual(["gr1"]);
    expect(markGoalContinuation).toHaveBeenCalledWith("gr1", "cancelled");
  });

  it("promotes queued prompt into active run and updates metadata", async () => {
    const { options, sessions, runs, inputs, activeRuns, queuedRuns } = createMockControlOptions();
    sessions.set("s1", { id: "s1", cwd: "/project", status: "open" });
    inputs.set("inp-1", {
      id: "inp-1",
      sessionId: "s1",
      items: [{ type: "text", text: "steer queued" }],
      delivery: "queue",
      attachments: [],
      metadata: {},
      createdAt: 1,
    } as any);
    runs.set("r-q1", {
      id: "r-q1",
      sessionId: "s1",
      inputId: "inp-1",
      status: "pending",
      metadata: {},
      createdAt: 1,
      updatedAt: 1,
    });
    runs.set("r-act", {
      id: "r-act",
      sessionId: "s1",
      status: "running",
      metadata: {},
      createdAt: 1,
      updatedAt: 1,
    });
    activeRuns.set("s1", "r-act");
    queuedRuns.set("s1", ["r-q1"]);

    const service = new RunControlService(options);
    const promoted = await service.promoteQueuedRun("s1", "inp-1", "r-q1", "r-act");

    expect(promoted).toBeDefined();
    expect(promoted?.queued_run.status).toBe("interrupted");
    expect(options.durableRuns.updateRun).toHaveBeenCalledWith("r-q1", expect.objectContaining({
      status: "interrupted",
      error: "Queued prompt was promoted into the active run",
    }));
  });

  it.each([
    ["input belongs to another session", { inputSessionId: "s2" }],
    ["queued run belongs to another session", { queuedSessionId: "s2" }],
    ["queued run belongs to another input", { queuedInputId: "inp-2" }],
    ["queued run is no longer pending", { queuedStatus: "completed" }],
    ["expected active run belongs to another session", { activeSessionId: "s2" }],
    ["expected active run is no longer running", { activeStatus: "completed" }],
    ["runtime owns a different active run", { runtimeActiveRunId: "r-other" }],
  ] as const)("rejects promotion before touching runtime when %s", async (_name, overrides) => {
    const { options, sessions, runs, inputs, activeRuns, queuedRuns } = createMockControlOptions();
    sessions.set("s1", { id: "s1", cwd: "/project", status: "open" });
    inputs.set("inp-1", {
      id: "inp-1",
      sessionId: overrides.inputSessionId ?? "s1",
      items: [{ type: "text", text: "steer queued" }],
      delivery: "queue",
      attachments: [],
      metadata: {},
      createdAt: 1,
    } as any);
    runs.set("r-q1", {
      id: "r-q1",
      sessionId: overrides.queuedSessionId ?? "s1",
      inputId: overrides.queuedInputId ?? "inp-1",
      status: overrides.queuedStatus ?? "pending",
      metadata: {},
      createdAt: 1,
      updatedAt: 1,
    });
    runs.set("r-act", {
      id: "r-act",
      sessionId: overrides.activeSessionId ?? "s1",
      status: overrides.activeStatus ?? "running",
      metadata: {},
      createdAt: 1,
      updatedAt: 1,
    });
    activeRuns.set("s1", overrides.runtimeActiveRunId ?? "r-act");
    queuedRuns.set("s1", ["r-q1"]);

    const service = new RunControlService(options);
    await expect(service.promoteQueuedRun("s1", "inp-1", "r-q1", "r-act")).resolves.toBeUndefined();

    expect(options.runtime.promoteQueuedRun).not.toHaveBeenCalled();
    expect(options.durableRuns.updateRun).not.toHaveBeenCalled();
  });

  it("awaits completed run and formats assistant output", async () => {
    const { options, runs, messages, messageParts } = createMockControlOptions();
    runs.set("r1", {
      id: "r1",
      sessionId: "s1",
      status: "completed",
      metadata: {},
      createdAt: 1,
      updatedAt: 1,
    });
    messages.set("s1", [
      { id: "m1", sessionId: "s1", runId: "r1", role: "assistant", createdAt: 1 } as any,
    ]);
    messageParts.set("s1", [
      { id: "p1", sessionId: "s1", messageId: "m1", type: "text", text: "Hello world", status: "completed", createdAt: 1, updatedAt: 1 },
    ]);

    const service = new RunControlService(options);
    const result = await service.awaitRun("s1", "r1");

    expect(result.status).toBe("completed");
    expect(result.output).toBe("Hello world");
  });

  it("stops and drains active sessions and queued runs", async () => {
    const { options, activeRuns, queuedRuns } = createMockControlOptions();
    activeRuns.set("s1", "r-act1");
    queuedRuns.set("s1", ["r-q1"]);

    const service = new RunControlService(options);
    await service.stopAndDrain("Shutdown test");

    expect(options.runtime.interruptSession).toHaveBeenCalledWith("s1", "Shutdown test");
    expect(options.runtime.waitForRuns).toHaveBeenCalledWith(["r-act1", "r-q1"]);
  });
});

import { describe, expect, it, vi } from "vitest";

import { SessionRunEngine } from "../session-run-engine.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("SessionRunEngine", () => {
  it.each([true, false])("waits for Goal settlement after execution preparation returns %s", async (accepted) => {
    const goalStarted = deferred();
    const releaseGoal = deferred();
    const steps: string[] = [];
    const engine = new SessionRunEngine({
      runExecutor: { execute: async () => { steps.push("execute"); } },
      events: { checkpoint: () => 7, publishSince: (checkpoint) => { steps.push(`publish:${checkpoint}`); } },
      execution: {
        prepareRunExecution: () => { steps.push("prepare"); return accepted; },
        recoverRejectedSteer: () => "recovered",
      },
      settleGoalRun: async () => { goalStarted.resolve(); await releaseGoal.promise; steps.push("goal"); },
    });
    engine.runtimeBridge.enqueueRun({ id: "model", sessionId: "s" } as any, "input");
    let singleFinished = false;
    let groupFinished = false;
    const single = engine.runtimeBridge.waitForRun("model").then(() => { singleFinished = true; });
    const group = engine.runtimeBridge.waitForRuns(["model"]).then(() => { groupFinished = true; });
    await goalStarted.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(steps).toEqual(accepted ? ["prepare", "publish:7", "execute"] : ["prepare", "publish:7"]);
    expect([singleFinished, groupFinished]).toEqual([false, false]);
    releaseGoal.resolve();
    await Promise.all([single, group]);
    expect([singleFinished, groupFinished]).toEqual([true, true]);
    expect(steps.at(-1)).toBe("goal");
  });

  it("cancels queued host work without interrupting the active model or settling a host Goal", async () => {
    const modelStarted = deferred();
    const releaseModel = deferred();
    const steps: string[] = [];
    const engine = new SessionRunEngine({
      runExecutor: { execute: async (_input, context) => {
        modelStarted.resolve();
        await releaseModel.promise;
        expect(context.signal.aborted).toBe(false);
        steps.push("model");
      } },
      events: { checkpoint: () => 0, publishSince: () => {} },
      execution: { prepareRunExecution: () => true, recoverRejectedSteer: () => "recovered" },
      settleGoalRun: async (_sessionId, runId) => { steps.push(`goal:${runId}`); },
    });
    engine.runtimeBridge.enqueueRun({ id: "model", sessionId: "s" } as any, "input");
    await modelStarted.promise;
    expect(engine.enqueueHostWork({ sessionId: "s", runId: "host", work: async () => { steps.push("host"); } })).toBe("queued");
    const hostWait = expect(engine.runtimeBridge.waitForRun("host")).rejects.toThrow("cancel host");
    expect(engine.runtimeBridge.interruptQueuedRun("s", "host", "cancel host")).toMatchObject({
      activeRunId: "model", queuedRunIds: ["host"], interrupted: true,
    });
    await hostWait;
    expect(engine.runtimeBridge.queuedRunIds("s")).toEqual([]);
    releaseModel.resolve();
    await engine.runtimeBridge.waitForRun("model");
    expect(steps).toEqual(["model", "goal:model"]);
  });

  it("runs host work in the same lane without absorbing steering or triggering Goal settlement", async () => {
    const order: string[] = [];
    let release!: () => void;
    const engine = new SessionRunEngine({ runExecutor: { execute: async () => { order.push("model"); } },
      events: { checkpoint: () => 0, publishSince: () => {} },
      execution: { prepareRunExecution: () => true, recoverRejectedSteer: () => "recovered" },
      settleGoalRun: async () => { order.push("goal"); } });
    engine.enqueueHostWork({ sessionId: "s", runId: "ui", work: async () => {
      order.push("ui"); await new Promise<void>(resolve => { release = resolve; });
    } });
    expect(engine.runtimeBridge.enqueueRun({ id: "model", sessionId: "s" } as any, "input")).toBe("queued");
    expect(engine.runtimeBridge.steer("s", { content: "hello", inputId: "other" } as any)).toEqual({ merged: false });
    expect(engine.runtimeBridge.promoteQueuedRun("s", "model", "ui", {} as any)).toMatchObject({ promoted: false });
    expect(order).toEqual(["ui"]);
    release(); await engine.runtimeBridge.waitForRuns(["ui", "model"]);
    expect(order).toEqual(["ui", "model", "goal"]);
  });
  it("owns lane execution without exposing admission or control facades", async () => {
    const execute = vi.fn(async () => {});
    const engine = new SessionRunEngine({
      runExecutor: { execute },
      events: { checkpoint: () => 0, publishSince: vi.fn() },
      execution: {
        prepareRunExecution: () => true,
        recoverRejectedSteer: () => "recovered-run",
      },
    });

    const state = engine.runtimeBridge.enqueueRun({
      id: "run-1", sessionId: "session-1", status: "pending",
    } as any, "input-1");
    await engine.runtimeBridge.waitForRuns(["run-1"]);

    expect(state).toBe("running");
    expect(execute).toHaveBeenCalledOnce();
    expect("admission" in engine).toBe(false);
    expect("control" in engine).toBe(false);
  });
});

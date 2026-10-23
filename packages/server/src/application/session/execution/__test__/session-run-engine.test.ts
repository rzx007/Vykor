import { describe, expect, it, vi } from "vitest";

import { SessionRunEngine } from "../session-run-engine.js";

describe("SessionRunEngine", () => {
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

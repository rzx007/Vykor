import { describe, expect, it, vi } from "vitest";

import { SessionRunEngine } from "../session-run-engine.js";

describe("SessionRunEngine", () => {
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

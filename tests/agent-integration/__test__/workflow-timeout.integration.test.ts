import { describe, expect, it, vi } from "vitest";
import { createLifecycleFixture, invokeLifecycleTool } from "./fixtures/task-lifecycle-fixture.js";

describe.each(["sdk", "daemon"] as const)("real Workflow invocation timeout: %s", mode => {
  it("stops the original worker at timeoutSeconds and waits for its actual cleanup", async () => {
    const fixture = await createLifecycleFixture(mode);
    const label = "workflow-invocation-deadline";
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      fixture.hold(label);
      fixture.holdCleanup(label);
      const run = await invokeLifecycleTool(fixture, "Workflow", {
        action: "run", mode: "parallel", timeoutSeconds: 0.2,
        tasks: [{ id: "work", prompt: label, subagentType: "worker" }],
      });
      await fixture.entered(label);
      const child = fixture.agent.children.list()[0]!;
      const originalRunId = child.runId!;
      // Admission and model startup are part of the deadline. Keep their real
      // work intact, then expire it once this test's Read gate has entered.
      await vi.advanceTimersByTimeAsync(200);
      expect((await fixture.agent.host.jobs.read({ sessionId: fixture.agent.id, target: run.target })).snapshot.status).toBe("stopping");
      expect(fixture.agent.host.inspect().childBudget.activeChildren).toBe(1);
      expect(child.readRun(originalRunId).result).toBeUndefined();
      expect(fixture.modelCalls(label)).toBe(1);
      fixture.release(label);
      await fixture.cleanupEntered(label);
      expect((await fixture.agent.host.jobs.read({ sessionId: fixture.agent.id, target: run.target })).snapshot.status).toBe("stopping");
      expect(fixture.agent.host.inspect().childBudget.activeChildren).toBe(1);
      fixture.releaseCleanup(label);
      const done = await fixture.wait(run.target);
      expect(done.snapshot.status).toBe("failed");
      expect((done.details as any).results.work).toMatchObject({ status: "failed", timedOut: true, attempts: 1,
        metadata: { workerTaskId: child.id, workerRunId: originalRunId } });
      expect(child.readRun(originalRunId).result?.status).toBe("interrupted");
      expect(fixture.agent.children.list()).toHaveLength(1);
      expect(fixture.agent.host.inspect().childBudget.activeChildren).toBe(0);
    } finally { vi.useRealTimers(); fixture.release(label); fixture.releaseCleanup(label); await fixture.close(); }
  }, 30_000);
});

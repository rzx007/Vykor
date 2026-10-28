import { describe, expect, it, vi } from "vitest";
import { createLifecycleFixture, invokeLifecycleTool } from "./fixtures/task-lifecycle-fixture.js";
import type { JobTarget } from "@vykor/jobs";

async function workflow(f: Awaited<ReturnType<typeof createLifecycleFixture>>, prompts: string[], extra: Record<string, unknown> = {}) {
  return invokeLifecycleTool(f, "Workflow", { action: "run", mode: "sequential", detached: true,
    tasks: prompts.map((prompt, i) => ({ id: `worker-${i}`, prompt, subagentType: "worker" })), ...extra });
}

describe.each(["sdk", "daemon"] as const)("real Workflow child lifecycle: %s", mode => {
  it("runs three Workflows with twelve sequential workers each under default 8/64 limits", async () => {
    const f = await createLifecycleFixture(mode);
    try {
      for (let round = 0; round < 3; round++) {
        const prompts = Array.from({ length: 12 }, (_, i) => `workflow-${round}-${i}`);
        const run = await workflow(f, prompts);
        const done = await f.wait(run.target, 15_000);
        expect(done.snapshot.status).toBe("completed");
        for (const prompt of prompts) { expect(done.text).toContain(prompt); expect(f.modelCalls(prompt)).toBe(1); }
      }
      expect(f.agent.host.inspect().childBudget).toMatchObject({ maxActiveChildren: 8, maxTotalChildren: 64, activeChildren: 0, totalChildren: 36 });
      expect(f.agent.children.list()).toHaveLength(36);
      expect(f.agent.children.list().every(child => child.state === "suspended")).toBe(true);
    } finally { await f.close(); }
  }, 60_000);

  it("holds eight actual runs, rejects the ninth in core and creates no compensating duplicate", async () => {
    const f = await createLifecycleFixture(mode);
    try {
      const prompts = Array.from({ length: 8 }, (_, i) => `parallel-${i}`);
      prompts.forEach(label => f.hold(label));
      const run = await workflow(f, prompts, { mode: "parallel", maxConcurrency: 8 });
      await Promise.all(prompts.map(label => f.entered(label)));
      expect(f.agent.host.inspect().childBudget.activeChildren).toBe(8);
      await expect(f.admit("ninth-rejected")).rejects.toThrow(/activeChildren/);
      expect(f.agent.host.inspect().childBudget).toMatchObject({ activeChildren: 8, totalChildren: 8 });
      expect(f.modelCalls("ninth-rejected")).toBe(0);
      expect(prompts.map(label => f.modelCalls(label))).toEqual(Array(8).fill(1));
      prompts.forEach(label => f.release(label));
      expect((await f.wait(run.target, 15_000)).snapshot.status).toBe("completed");
      expect(f.agent.host.inspect().childBudget).toMatchObject({ activeChildren: 0, totalChildren: 8 });
    } finally { await f.close(); }
  }, 30_000);

  it("expires before dispatching Read when model startup outlasts its attempt deadline", async () => {
    const f = await createLifecycleFixture(mode);
    const label = "startup-deadline";
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      f.hold(label); f.holdModel(label);
      let readEntered = false;
      void f.entered(label).then(() => { readEntered = true; });
      const run = await workflow(f, [label], { tasks: [{ id: "startup", prompt: label, subagentType: "worker", timeoutSeconds: 0.2 }] });
      await f.modelEntered(label);
      await vi.advanceTimersByTimeAsync(200);
      expect((await f.agent.host.jobs.read({ sessionId: f.agent.id, target: run.target })).snapshot.status).toBe("stopping");
      f.releaseModel(label);
      const done = await f.agent.host.jobs.wait({ sessionId: f.agent.id, target: run.target, timeoutMs: 5_000 });
      expect(done.snapshot.status).toBe("failed");
      expect((done.details as any).results.startup).toMatchObject({ status: "failed", timedOut: true, attempts: 1 });
      expect(readEntered).toBe(false);
      const [child] = f.agent.children.list();
      expect(f.agent.children.list()).toHaveLength(1);
      expect((await child!.waitRun(child!.runId!)).result?.status).toBe("interrupted");
      expect(f.modelCalls(label)).toBe(1);
      expect(f.agent.host.inspect().childBudget.activeChildren).toBe(0);
    } finally { vi.useRealTimers(); await f.close(); }
  }, 30_000);

  it.each(["cancel", "deadline"] as const)("keeps %s stopping through the actual Read and cleanup with no overlapping retry", async source => {
    const f = await createLifecycleFixture(mode);
    const label = `held-${source}`;
    let cancellation: Promise<unknown> | undefined;
    if (source === "deadline") vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      f.hold(label); f.holdCleanup(label);
      const run = await workflow(f, [label], { tasks: [{ id: "held", prompt: label, subagentType: "worker", retry: { maxAttempts: 2 }, ...(source === "deadline" ? { timeoutSeconds: 0.2 } : {}) }] });
      const target = run.target as JobTarget;
      await f.entered(label);
      // The deadline includes admission and model startup. Advance it only once
      // the real Read has entered, so host load cannot cancel before this gate.
      if (source === "deadline") await vi.advanceTimersByTimeAsync(200);
      if (source === "cancel") { cancellation = f.agent.host.jobs.cancel({ sessionId: f.agent.id, target }); void cancellation.catch(() => {}); }
      await vi.waitFor(async () => expect((await f.agent.host.jobs.read({ sessionId: f.agent.id, target })).snapshot.status).toBe("stopping"));
      expect(f.agent.host.inspect().childBudget.activeChildren).toBe(1);
      expect(f.modelCalls(label)).toBe(1);
      f.release(label);
      await f.cleanupEntered(label);
      if (source === "deadline") await vi.advanceTimersByTimeAsync(5_100);
      expect((await f.agent.host.jobs.read({ sessionId: f.agent.id, target })).snapshot.status).toBe("stopping");
      expect(f.agent.host.inspect().childBudget.activeChildren).toBe(1);
      expect(f.agent.children.list()).toHaveLength(1);
      expect(f.modelCalls(label)).toBe(1);
      f.releaseCleanup(label);
      await cancellation;
      const done = await f.wait(target, 15_000);
      expect(["failed", "killed", "completed"]).toContain(done.snapshot.status);
      if (source === "deadline") expect(f.agent.children.list()).toHaveLength(2);
      expect(f.agent.host.inspect().childBudget.activeChildren).toBe(0);
    } finally { vi.useRealTimers(); f.release(label); f.releaseCleanup(label); await cancellation?.catch(() => {}); await f.close(); }
  }, 30_000);

  it("keeps a late original attempt observation from replacing the new real run", async () => {
    const label = "retry-held";
    const f = await createLifecycleFixture(mode, { failure: { label, kind: "failed", once: true } });
    try {
      f.hold(label);
      const run = await workflow(f, [label], { tasks: [{ id: "retry", prompt: label, subagentType: "worker", retry: { maxAttempts: 2 } }] });
      await f.entered(label);
      const children = f.agent.children.list();
      expect(children).toHaveLength(2);
      const old = children.find(child => child.state === "idle")!;
      const current = children.find(child => child.state === "running")!;
      const late = await old.waitRun(old.runId!);
      expect(late.result?.status).toBe("failed");
      if (mode === "daemon") await f.redeliverTerminal(old.runId!);
      const active = await f.agent.host.jobs.read({ sessionId: f.agent.id, target: run.target });
      expect(active.snapshot.status).toBe("running");
      expect((active.details as any).runningTasks.retry.metadata).toMatchObject({ workerTaskId: current.id, workerRunId: current.runId });
      f.release(label);
      const done = await f.wait(run.target);
      expect((done.details as any).results.retry).toMatchObject({ status: "completed", attempts: 2, metadata: { workerTaskId: current.id, workerRunId: current.runId } });
      expect(old.readRun(old.runId!).result).toEqual(late.result);
    } finally { f.release(label); await f.close(); }
  }, 30_000);

  it("waits a failed started ACK's actual invocation and cleanup before retry", async () => {
    const f = await createLifecycleFixture(mode, { failStartedAck: true });
    const label = "ack-held";
    try {
      f.hold(label); f.holdCleanup(label);
      const run = await workflow(f, [label], { tasks: [{ id: "ack", prompt: label, subagentType: "worker", retry: { maxAttempts: 2 } }] });
      // A reliable ACK rejection prevents model dispatch. Its original cleanup
      // still has to confirm before the second actual child can be admitted.
      await f.cleanupEntered(label);
      expect(f.agent.children.list()).toHaveLength(1);
      expect(f.agent.host.inspect().childBudget.activeChildren).toBe(1);
      f.releaseCleanup(label);
      await f.entered(label);
      expect(f.agent.host.inspect().childBudget.activeChildren).toBe(1);
      f.release(label);
      const done = await f.wait(run.target);
      expect((done.details as any).results.ack.attempts).toBe(2);
      expect(f.modelCalls(label)).toBe(2); // real Read + final response of only the admitted retry
      expect(f.agent.host.inspect().childBudget.activeChildren).toBe(0);
    } finally { f.release(label); f.releaseCleanup(label); await f.close(); }
  }, 30_000);

  it.each([false, true])("does not retry a query failure while its actual worker invocation and cleanup remain active (deadline: %s)", async deadline => {
    const f = await createLifecycleFixture(mode);
    const label = "query-held";
    let restore = () => {};
    try {
      const seed = await f.admit("query-prototype"); await seed.handle.waitRun(seed.target.runId);
      const prototype = Object.getPrototypeOf(seed.handle);
      const waitRun = prototype.waitRun;
      let injected = false;
      const spy = vi.spyOn(prototype, "waitRun").mockImplementation(async function(this: any, runId: string) {
        if (this.id !== seed.handle.id && !injected) { injected = true; await f.entered(label); throw new Error("injected original query failure"); }
        return waitRun.call(this, runId);
      });
      restore = () => spy.mockRestore();
      f.hold(label); f.holdCleanup(label);
      if (deadline) vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const run = await workflow(f, [label], { tasks: [{ id: "query", prompt: label, subagentType: "worker", retry: { maxAttempts: 2 }, ...(deadline ? { timeoutSeconds: 0.2 } : {}) }] });
      await f.entered(label);
      await vi.waitFor(async () => expect((await f.agent.host.jobs.read({ sessionId: f.agent.id, target: run.target })).snapshot.status).toBe("stopping"));
      expect(f.agent.children.list()).toHaveLength(2);
      expect(f.agent.host.inspect().childBudget.activeChildren).toBe(1);
      if (deadline) await vi.advanceTimersByTimeAsync(200);
      f.release(label); await f.cleanupEntered(label);
      expect((await f.agent.host.jobs.read({ sessionId: f.agent.id, target: run.target })).snapshot.status).toBe("stopping");
      expect(f.agent.children.list()).toHaveLength(2);
      f.releaseCleanup(label);
      const done = await f.wait(run.target);
      expect(done.snapshot.status).toBe("failed");
      expect((done.details as any).results.query).toMatchObject({ attempts: 1, metadata: { workerQueryFailed: true, retryable: false } });
      if (deadline) expect((done.details as any).results.query.timedOut).toBe(true);
      expect(f.modelCalls(label)).toBe(1);
    } finally { vi.useRealTimers(); restore(); f.release(label); f.releaseCleanup(label); await f.close(); }
  }, 30_000);

  it("lets repeated Workflow cancellation retry only the original failed cleanup", async () => {
    const label = "cancel-recovery";
    const f = await createLifecycleFixture(mode, { failCleanupOnce: label });
    let first: Promise<unknown> | undefined;
    try {
      f.hold(label);
      const run = await workflow(f, [label]);
      await f.entered(label);
      const host = f.agent.host.workflows!;
      first = host.cancelPersistentWorkflow(run.jobId); void first.catch(() => {});
      f.release(label);
      const child = f.agent.children.list()[0]!;
      await vi.waitFor(() => expect(child.readRun(child.runId!).cleanupUnconfirmed?.message).toContain("injected run cleanup failure"));
      expect((await f.agent.host.jobs.read({ sessionId: f.agent.id, target: run.target })).snapshot.status).toBe("stopping");
      const second = host.cancelPersistentWorkflow(run.jobId);
      expect(second).toBe(first);
      await second;
      expect((await f.wait(run.target)).snapshot.status).toBe("killed");
      expect(f.agent.children.list()).toHaveLength(1);
      expect(f.modelCalls(label)).toBe(1);
      expect(f.agent.host.inspect().childBudget.activeChildren).toBe(0);
    } finally { f.release(label); await first?.catch(() => {}); await f.close(); }
  }, 30_000);

  it("orders same-tick actual send before old-run suspend without deadlocking", async () => {
    const f = await createLifecycleFixture(mode);
    try {
      const child = await f.admit("same-tick-first"); await child.handle.waitRun(child.target.runId);
      let tools!: import("@vykor/agent-contracts").AgentExecutionContext["tools"];
      await f.inRootRun(async execution => { tools = execution.tools; });
      f.hold("same-tick-next");
      const sent = child.handle.send({ content: "same-tick-next" }, tools);
      const suspended = child.handle.requestSuspend!(child.target.runId);
      const receipt = await sent;
      expect(await suspended).toBe(false);
      await f.entered("same-tick-next");
      f.release("same-tick-next"); await child.handle.waitRun(receipt.runId);
      expect(await child.handle.requestSuspend!(receipt.runId)).toBe(true);
    } finally { f.release("same-tick-next"); await f.close(); }
  }, 30_000);

  it("resumes the same suspended identity with history, cwd and captured authorization", async () => {
    const f = await createLifecycleFixture(mode);
    try {
      f.hold("history-first");
      const run = await workflow(f, ["history-first"]);
      await f.entered("history-first"); f.release("history-first");
      const done = await f.wait(run.target);
      expect(done.snapshot.status).toBe("completed");
      const handle = f.agent.children.list()[0]!;
      const originalRun = handle.runId!;
      expect(handle.state).toBe("suspended");
      const cwd = f.observedCwd("history-first");
      await expect(handle.send({ content: "unauthorized" }, new Map())).rejects.toThrow(/not authorized/);
      f.hold("history-followup");
      const receipt = await f.sendAccepted({ kind: "agent", jobId: handle.id, runId: originalRun }, "history-followup");
      await f.entered("history-followup");
      expect(handle.runId).toBe(receipt.runId);
      expect(f.agent.children.get(handle.id)).toBe(handle);
      expect(f.observedHistory("history-followup").join(" ")).toContain("history-first");
      expect(f.observedCwd("history-followup")).toBe(cwd);
      expect(await handle.requestSuspend!(originalRun)).toBe(false);
      expect(await handle.requestSuspend!(receipt.runId)).toBe(false);
      f.release("history-followup");
      await handle.waitRun(receipt.runId);
      expect(await handle.requestSuspend!(originalRun)).toBe(false);
      expect(await handle.requestSuspend!(receipt.runId)).toBe(true);
      expect(handle.state).toBe("suspended");
    } finally { await f.close(); }
  }, 30_000);
  it("retains a parent with an active and later idle descendant", async () => {
    const f = await createLifecycleFixture(mode);
    try {
      f.hold("descendant-held");
      let parentId!: string;
      await f.inRootRun(async execution => {
        const child = await execution.children.spawnChildAgent({ description: "parent", prompt: "parent-retained", agent: "general-purpose", cwd: execution.scope.cwd, allowedTools: ["Agent", "Read"] });
        parentId = child.id;
      });
      await f.entered("descendant-held");
      const parent = f.agent.children.get(parentId)!;
      await parent.waitRun(parent.runId!);
      expect(await parent.requestSuspend!(parent.runId!)).toBe(false);
      expect(parent.state).toBe("idle");
      const descendant = f.agent.children.list().find(child => child.id !== parent.id)!;
      expect(descendant.state).toBe("running");
      f.release("descendant-held"); await descendant.waitRun(descendant.runId!);
      expect(await parent.requestSuspend!(parent.runId!)).toBe(false);
      expect(f.agent.children.get(descendant.id)).toBe(descendant);
    } finally { await f.close(); }
  }, 30_000);

  it("keeps a real pending approval resident until its run stops", async () => {
    const f = await createLifecycleFixture(mode);
    try {
      f.holdApproval();
      let id!: string;
      await f.inRootRun(async execution => {
        const child = await execution.children.spawnChildAgent({ description: "approval", prompt: "approval-held", agent: "worker", cwd: execution.scope.cwd, permissionMode: "default", allowedTools: ["Write"] });
        id = child.id;
      });
      await f.approvalEntered();
      const child = f.agent.children.get(id)!;
      expect(await child.requestSuspend!(child.runId!)).toBe(false);
      expect(child.state).toBe("running");
      f.releaseApproval(); await child.waitRun(child.runId!);
      expect(await child.requestSuspend!(child.runId!)).toBe(true);
    } finally { f.releaseApproval(); await f.close(); }
  }, 30_000);

});


it("daemon rejects an explicit unsupported model before acquiring its child environment", async () => {
  const f = await createLifecycleFixture("daemon", { catalogModels: ["offline"] });
  try {
    await expect(f.inRootRun(async execution => {
      await execution.children.spawnChildAgent({ description: "unsupported", prompt: "unsupported", agent: "worker", cwd: execution.scope.cwd, model: "unsupported" });
    })).rejects.toThrow(/not available/);
    expect(f.environmentAcquires()).toBe(0);
    expect(f.modelCalls("unsupported")).toBe(0);
    expect(f.agent.host.inspect().childBudget.activeChildren).toBe(0);
  } finally { await f.close(); }
});

it.each(["warm", "suspended"] as const)("daemon rechecks current model availability for a %s identity", async residency => {
  const f = await createLifecycleFixture("daemon", { catalogModels: ["offline"] });
  try {
    const first = await f.admit("authorized-first");
    await first.handle.waitRun(first.target.runId);
    let tools!: import("@vykor/agent-contracts").AgentExecutionContext["tools"];
    await f.inRootRun(async execution => { tools = execution.tools; });
    if (residency === "suspended") expect(await first.handle.requestSuspend!(first.target.runId)).toBe(true);
    f.setCatalogModels([]);
    if (residency === "suspended") await expect(first.handle.send({ content: "revoked-followup" }, tools)).rejects.toThrow(/not available/);
    else {
      const receipt = await first.handle.send({ content: "revoked-followup" }, tools);
      expect((await first.handle.waitRun(receipt.runId)).result?.status).toBe("failed");
    }
    expect(f.modelCalls("revoked-followup")).toBe(0);
    expect(first.handle.readRun(first.target.runId).result).toMatchObject({ status: "completed", output: "authorized-first" });
    expect(f.environmentAcquires()).toBe(1);
  } finally { f.setCatalogModels(["offline"]); await f.close(); }
});

it("SDK with its own client preserves an explicit custom model", async () => {
  const f = await createLifecycleFixture("sdk");
  try {
    await f.inRootRun(async execution => {
      const child = await execution.children.spawnChildAgent({ description: "custom", prompt: "custom-model", agent: "worker", cwd: execution.scope.cwd, model: "sdk-custom-model" });
      expect((await f.agent.children.get(child.id)!.waitRun(child.runId)).result?.output).toBe("custom-model");
    });
    expect(f.modelCalls("custom-model")).toBe(1);
  } finally { await f.close(); }
});

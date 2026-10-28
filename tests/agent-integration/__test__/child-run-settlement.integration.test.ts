import { expect, it, vi } from "vitest";
import { createLifecycleFixture, invokeLifecycleTool } from "./fixtures/task-lifecycle-fixture.js";

it.each(["sdk", "daemon"] as const)("returns run permits for 24 followups and 24 identities: %s", async mode => {
  const f = await createLifecycleFixture(mode, { childBudget: { maxActiveChildren: 1 } });
  try {
    const first = await f.spawn("run-0");
    let target = first.target;
    const initial = await f.wait(target);
    expect(initial.snapshot.status).toBe("completed");
    expect(initial.text).toBe("run-0");
    target = { ...target, runId: (await f.send(target, "run-1")).runId };
    let lastIdentity = target;
    // Exercise every real child run inside one captured root scope. Reopening
    // a model/store Run for every observation measures root history growth,
    // rather than child permit reuse. The external tool path remains checked
    // before and after these loops.
    await f.inRootRun(async execution => {
      for (let n = 1; n < 24; n++) {
        const result = await first.handle.waitRun(target.runId);
        expect(result.result).toMatchObject({ status: "completed", output: `run-${n}` });
        expect(f.agent.host.inspect().childBudget.activeChildren).toBe(0);
        if (n < 23) target = { ...target, runId: (await execution.children.sendChildInput(first.handle.id, { content: `run-${n + 1}` })).runId };
      }
      for (let n = 0; n < 24; n++) {
        const receipt = await execution.children.spawnChildAgent({ prompt: `identity-${n}`, description: `identity-${n}`, agent: "worker", cwd: execution.scope.cwd, allowedTools: ["Read"] });
        const handle = f.agent.children.get(receipt.id)!;
        expect((await handle.waitRun(receipt.runId)).result).toMatchObject({ status: "completed", output: `identity-${n}` });
        expect(f.agent.host.inspect().childBudget.activeChildren).toBe(0);
        lastIdentity = { kind: "agent", jobId: handle.id, runId: receipt.runId };
      }
    });
    expect(first.handle.id).toBe(target.jobId);
    expect(first.handle.state).not.toBe("closed");
    const finalFollowup = await f.wait(target);
    expect(finalFollowup.snapshot.status).toBe("completed");
    expect(finalFollowup.text).toBe("run-23");
    const finalIdentity = await f.wait(lastIdentity);
    expect(finalIdentity.snapshot.status).toBe("completed");
    expect(finalIdentity.text).toBe("identity-23");
  } finally { await f.close(); }
}, 60_000);

it.each(["sdk", "daemon"] as const)("keeps a cancelled real Read permit until invocation exits: %s", async mode => {
  const f = await createLifecycleFixture(mode, { childBudget: { maxActiveChildren: 1 } });
  try {
    f.hold("held-tool");
    const a = await f.spawn("held-tool");
    await f.entered("held-tool");
    expect((await f.cancel(a.target)).status).toBe("stopping");
    await expect(f.admit("must-be-rejected")).rejects.toThrow("activeChildren");
    expect(a.handle.readRun(a.target.runId).result).toBeUndefined();
    f.release("held-tool");
    await a.handle.waitRun(a.target.runId);
    const b = await f.spawn("capacity-returned");
    expect((await f.wait(b.target)).text).toBe("capacity-returned");
  } finally { await f.close(); }
});

it("preserves the actual daemon outcome and releases capacity when terminal storage fails", async () => {
  const f = await createLifecycleFixture("daemon", { childBudget: { maxActiveChildren: 1 }, failTerminalSave: true });
  try {
    const a = await f.spawn("saved-later");
    await a.handle.waitRun(a.target.runId);
    await vi.waitFor(() => expect(a.handle.readRun(a.target.runId).projectionError).toBeDefined());
    expect(a.handle.readRun(a.target.runId).result).toMatchObject({ status: "completed", output: "saved-later" });
    const b = await f.spawn("next-run");
    expect(b.target.runId).not.toBe(a.target.runId);
    await f.restoreTerminalSave();
    expect(f.store!.runs.getRun(a.target.runId)?.status).toBe("completed");
    expect((await f.read(a.target)).text).toBe("saved-later");
    expect(f.modelCalls("saved-later")).toBe(1);
    expect(a.handle.readRun(a.target.runId).projectionError).toBeUndefined();
  } finally { await f.close(); }
});

it.each(["sdk", "daemon"] as const)("counts 64 identities without retaining completed run permits: %s", async mode => {
  const f = await createLifecycleFixture(mode, { childBudget: { maxActiveChildren: 1 } });
  try {
    const first = await f.spawn("total-0");
    const initial = await f.wait(first.target);
    expect(initial.snapshot.status).toBe("completed");
    expect(initial.text).toBe("total-0");
    let last = first.target;
    await f.inRootRun(async execution => {
      for (let n = 1; n < 64; n++) {
        const receipt = await execution.children.spawnChildAgent({ prompt: `total-${n}`, description: `total-${n}`, agent: "worker", cwd: execution.scope.cwd, allowedTools: ["Read"] });
        const handle = f.agent.children.get(receipt.id)!;
        expect((await handle.waitRun(receipt.runId)).result).toMatchObject({ status: "completed", output: `total-${n}` });
        expect(f.agent.host.inspect().childBudget.activeChildren).toBe(0);
        last = { kind: "agent", jobId: handle.id, runId: receipt.runId };
      }
    });
    const final = await f.wait(last);
    expect(final.snapshot.status).toBe("completed");
    expect(final.text).toBe("total-63");
    await expect(f.admit("identity-65")).rejects.toThrow("totalChildren");
    expect(f.agent.children.list()).toHaveLength(64);
    expect(f.modelCalls("identity-65")).toBe(0);
  } finally { await f.close(); }
}, 120_000);

it.each(["sdk", "daemon"] as const)("atomically rejects both ninth and tenth actual held runs: %s", async mode => {
  const f = await createLifecycleFixture(mode);
  try {
    for (let n = 0; n < 10; n++) f.hold(`race-${n}`);
    const children = [];
    for (let n = 0; n < 8; n++) children.push(await f.spawn(`race-${n}`));
    await Promise.all(children.map((_, n) => f.entered(`race-${n}`)));
    const rejected = await f.admitMany(["race-8", "race-9"]);
    expect(rejected.map(result => result.status)).toEqual(["rejected", "rejected"]);
    for (const result of rejected) if (result.status === "rejected") expect(String(result.reason)).toContain("activeChildren");
    expect(Array.from({ length: 10 }, (_, n) => f.modelCalls(`race-${n}`))).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 0, 0]);
    f.release("race-0");
    await children[0]!.handle.waitRun(children[0]!.target.runId);
    // Duplicate reads/waits cannot release the same old permit twice.
    await children[0]!.handle.waitRun(children[0]!.target.runId);
    const replacements = await f.admitMany(["race-8", "race-9"]);
    expect(replacements.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(replacements.filter(result => result.status === "rejected")).toHaveLength(1);
    await f.entered(`race-${8 + replacements.findIndex(result => result.status === "fulfilled")}`);
    expect(f.modelCalls("race-8") + f.modelCalls("race-9")).toBe(1);
  } finally { await f.close(); }
});

it.each(["sdk", "daemon"] as const)("makes retained identities compete for one run permit: %s", async mode => {
  const f = await createLifecycleFixture(mode, { childBudget: { maxActiveChildren: 1 } });
  try {
    const a = await f.spawn("identity-a"); await f.wait(a.target);
    const b = await f.spawn("identity-b"); await f.wait(b.target);
    f.hold("send-a"); f.hold("send-b");
    const races = await f.sendMany([{ target: a.target, text: "send-a" }, { target: b.target, text: "send-b" }]);
    expect(races.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(races.filter(result => result.status === "rejected")).toHaveLength(1);
    await f.entered(races[0]!.status === "fulfilled" ? "send-a" : "send-b");
    expect(f.modelCalls("send-a") + f.modelCalls("send-b")).toBe(1);
  } finally { await f.close(); }
});

it.each(["sdk", "daemon"] as const)("waits for both real invocation and run cleanup after timeout: %s", async mode => {
  const f = await createLifecycleFixture(mode, { childBudget: { maxActiveChildren: 1 } });
  try {
    f.hold("deadline"); f.holdCleanup("deadline");
    const a = await f.admit("deadline", 1);
    await f.entered("deadline");
    await vi.waitFor(() => expect(a.handle.readRun(a.target.runId).stopping).toBe(true), { timeout: 3_000 });
    await expect(f.admit("timeout-still-held")).rejects.toThrow("activeChildren");
    f.release("deadline");
    await f.cleanupEntered("deadline");
    expect(a.handle.readRun(a.target.runId).result).toBeUndefined();
    await expect(f.admit("cleanup-still-held")).rejects.toThrow("activeChildren");
    f.releaseCleanup("deadline");
    expect((await a.handle.waitRun(a.target.runId)).result).toMatchObject({ status: "failed", failureKind: "timeout" });
    const b = await f.spawn("deadline-released");
    expect((await f.wait(b.target)).text).toBe("deadline-released");
  } finally { await f.close(); }
});

it("keeps Agent tool capacity refusal under explicitly enabled unknown write protection", async () => {
  const f = await createLifecycleFixture("daemon", { childBudget: { maxActiveChildren: 1 }, blockOnUnknownToolOutcome: true });
  try {
    f.hold("occupied");
    const a = await f.spawn("occupied"); await f.entered("occupied");
    const refused = f.spawn("tool-capacity-refusal");
    void refused.catch(() => {});
    await vi.waitFor(() => expect(f.store!.toolOperations.list().some(operation => operation.toolName === "Agent" && operation.state === "unknown")).toBe(true));
    const operations = f.store!.toolOperations.list();
    expect(operations.some(operation => operation.toolName === "Agent" && operation.state === "unknown")).toBe(true);
    expect(f.modelCalls("tool-capacity-refusal")).toBe(0);
    const stopped = a.handle.waitRun(a.target.runId);
    f.release("occupied"); await stopped;
    await expect(refused).rejects.toThrow("Child agent budget exceeded for activeChildren");
    await expect(f.spawn("guard-still-protects")).rejects.toThrow("Unknown or unresolved write operation");
  } finally { await f.close(); }
});

it.each(["sdk", "daemon"] as const)("bounds saved followups and reads only the evicted original run: %s", async mode => {
  const f = await createLifecycleFixture(mode, { childBudget: { maxActiveChildren: 1 } });
  try {
    const a = await f.spawn("retained-0");
    let target = a.target;
    await f.inRootRun(async execution => {
      for (let n = 0; n < 260; n++) {
        expect((await a.handle.waitRun(target.runId)).result?.output).toBe(`retained-${n}`);
        if (n < 259) target = { ...target, runId: (await execution.children.sendChildInput(a.handle.id, { content: `retained-${n + 1}` })).runId };
      }
    });
    expect(() => a.handle.readRun(a.target.runId)).toThrow("RUN_RESULT_NOT_RETAINED");
    if (mode === "daemon") {
      const archived = await f.read(a.target);
      expect(archived.text).toBe("retained-0");
      expect(archived.snapshot.target).toEqual(a.target);
      expect(archived.snapshot.status).toBe("completed");
    } else await expect(f.read(a.target)).rejects.toThrow("RUN_RESULT_NOT_RETAINED");
  } finally { await f.close(); }
}, 240_000);

it("rejects admission at unsaved retention saturation, then repairs the same runs without replay", async () => {
  const f = await createLifecycleFixture("daemon", { childBudget: { maxActiveChildren: 1 }, failTerminalSave: true });
  try {
    const a = await f.spawn("unsaved-0"); let target = a.target;
    await f.inRootRun(async execution => {
      for (let n = 0; n < 256; n++) {
        await a.handle.waitRun(target.runId);
        await vi.waitFor(() => expect(a.handle.readRun(target.runId).projectionError).toBeDefined());
        if (n < 255) target = { ...target, runId: (await execution.children.sendChildInput(a.handle.id, { content: `unsaved-${n + 1}` })).runId };
      }
    });
    await expect(f.sendAccepted(target, "must-not-evict")).rejects.toThrow("CHILD_RESULT_RETENTION_FULL");
    expect(a.handle.readRun(a.target.runId).result?.output).toBe("unsaved-0");
    expect(a.handle.readRun(target.runId).result?.status).toBe("completed");
    await f.restoreTerminalSave();
    expect(f.store!.runs.getRun(a.target.runId)?.status).toBe("completed");
    expect(f.modelCalls("unsaved-0")).toBe(1);
    expect(f.modelCalls("must-not-evict")).toBe(0);
    const receipt = await f.send(target, "after-recovery");
    expect((await f.wait({ ...target, runId: receipt.runId })).text).toBe("after-recovery");
  } finally { await f.close(); }
}, 240_000);

it("propagates a recovered started projection failure and retains the permit through environment cleanup", async () => {
  const f = await createLifecycleFixture("daemon", { childBudget: { maxActiveChildren: 1 }, failStartedAck: true });
  try {
    f.holdCleanup("start-fails");
    await expect(f.admit("start-fails")).rejects.toThrow("injected started projection failure");
    await f.cleanupEntered("start-fails");
    const handle = f.agent.children.list()[0]!;
    expect(handle).toBeDefined();
    expect(handle.state).toBe("closing");
    expect(f.modelCalls("start-fails")).toBe(0);
    expect(f.store!.listProjectionSettlements().some(record => record.action === "compensate-child" && record.status === "resolved")).toBe(true);
    await expect(f.admit("blocked-by-cleanup")).rejects.toThrow("activeChildren");
    f.releaseCleanup("start-fails");
    await vi.waitFor(() => expect(f.agent.children.list()).toHaveLength(0));
    const next = await f.spawn("after-start-cleanup");
    expect((await f.wait(next.target)).text).toBe("after-start-cleanup");
  } finally { await f.close(); }
});

it("repairs and redelivers old A without changing running B or releasing B's permit", async () => {
  const f = await createLifecycleFixture("daemon", { childBudget: { maxActiveChildren: 1 }, failTerminalSave: true });
  try {
    const a = await f.spawn("old-A");
    await a.handle.waitRun(a.target.runId);
    await vi.waitFor(() => expect(a.handle.readRun(a.target.runId).projectionError).toBeDefined());
    f.hold("new-B");
    const b = { ...a.target, runId: (await f.send(a.target, "new-B")).runId };
    await f.entered("new-B");
    await f.restoreTerminalSave();
    await f.redeliverTerminal(a.target.runId);
    await f.redeliverTerminal(a.target.runId);
    expect(a.handle.runId).toBe(b.runId);
    expect(a.handle.readRun(b.runId).result).toBeUndefined();
    expect(f.store!.runs.getSessionTask(a.handle.id)).toMatchObject({ runId: b.runId, status: "running" });
    expect(f.store!.runs.getRun(a.target.runId)).toMatchObject({ status: "completed" });
    expect((await f.read(a.target)).text).toBe("old-A");
    await expect(f.admit("B-still-owns-permit")).rejects.toThrow("activeChildren");
    expect(f.modelCalls("old-A")).toBe(1);
    f.release("new-B");
    expect((await f.wait(b)).text).toBe("new-B");
    expect(f.store!.conversations.listEvents({ sessionId: a.handle.sessionId }).filter(event => event.type === "session.run.error" && event.payload.runId === a.target.runId)).toHaveLength(0);
  } finally { await f.close(); }
});

it("repairs a real Shell terminal save using the existing process payload without restarting it", async () => {
  const f = await createLifecycleFixture("daemon", { failShellSave: true });
  try {
    const created = await invokeLifecycleTool(f, "BackgroundShellCreate", { command: "node -e \"process.stdout.write('shell-original')\"", description: "shell-save" });
    const target = created.target;
    expect((await f.wait(target)).text).toBe("shell-original");
    const pending = f.store!.listProjectionSettlements().find(record => record.projector === `process-terminal:${target.jobId}`)!;
    expect(pending).toMatchObject({ action: "retry-terminal-projection", eventSequence: 1, status: "pending", payload: { durableTaskId: target.jobId, execution: { id: target.jobId, status: "completed", output: "shell-original" } } });
    expect(pending.payload.event).toBeUndefined();
    await f.restoreTerminalSave();
    expect(f.store!.runs.getSessionTask(target.jobId)).toMatchObject({ status: "completed", output: "shell-original" });
    expect(f.store!.getProjectionSettlement(pending.id)?.status).toBe("resolved");
    expect((await f.read(target)).text).toBe("shell-original");
  } finally { await f.close(); }
});

it.each(["completed", "failed", "max_turns", "timeout", "user_cancelled"] as const)("preserves identical live, terminal-event and recovered %s output", async cause => {
  const label = `partial-${cause}`;
  const f = await createLifecycleFixture("daemon", { failTerminalSave: true, ...(cause === "failed" || cause === "max_turns" ? { failure: { label, kind: cause } } : {}) });
  try {
    if (cause === "timeout" || cause === "user_cancelled") f.hold(label);
    const a = cause === "timeout" ? await f.admit(label, 1) : await f.spawn(label);
    if (cause === "timeout" || cause === "user_cancelled") {
      await f.entered(label);
      if (cause === "user_cancelled") await f.cancel(a.target);
      else await vi.waitFor(() => expect(a.handle.readRun(a.target.runId).stopping).toBe(true), { timeout: 3_000 });
      f.release(label);
    }
    const actual = (await a.handle.waitRun(a.target.runId)).result!;
    await vi.waitFor(() => expect(a.handle.readRun(a.target.runId).projectionError).toBeDefined());
    const pending = f.store!.listProjectionSettlements().find(record => (record.payload.event as any)?.context.runId === a.target.runId)!;
    const event = pending.payload.event as any;
    expect(event.data.output).toBe(actual.output);
    expect(event.data.failureKind).toBe(actual.failureKind);
    expect(event.data.partialResult).toEqual(actual.partialResult);
    if (cause === "max_turns") expect(actual.output).toHaveLength(12_000);
    if (cause === "timeout" || cause === "user_cancelled") expect(actual.output).toBe(`committed:${label}`);
    await f.restoreTerminalSave();
    const run = f.store!.runs.getRun(a.target.runId)!;
    expect(run.status).toBe(actual.status);
    expect(run.metadata.terminalOutput).toBe(actual.output);
    expect(f.store!.runs.getSessionTask(a.handle.id)?.output).toBe(actual.output);
    expect((run.metadata.childFailure as any)?.failureKind).toBe(actual.failureKind);
    expect((run.metadata.childFailure as any)?.partialResult).toEqual(actual.partialResult);
    await f.redeliverTerminal(a.target.runId);
    expect(a.handle.readRun(a.target.runId).result).toEqual(actual);
    expect(f.modelCalls(label)).toBe(cause === "max_turns" ? 2 : 1);
  } finally { await f.close(); }
});

it.each(["sdk", "daemon"] as const)("does not retain more than 256 explicitly rejected input placeholders: %s", async mode => {
  const f = await createLifecycleFixture(mode, { childBudget: { maxActiveChildren: 1 } });
  try {
    const idle = await f.spawn("idle-for-refusals"); await f.wait(idle.target);
    f.hold("occupier");
    const held = await f.spawn("occupier"); await f.entered("occupier");
    await f.inRootRun(async execution => {
      for (let n = 0; n < 270; n++) await expect(execution.children.sendChildInput(idle.handle.id, { id: `rejected-${n}`, content: "refused" })).rejects.toThrow("activeChildren");
      f.release("occupier"); await held.handle.waitRun(held.target.runId);
      const receipt = await execution.children.sendChildInput(idle.handle.id, { id: "accepted-after-refusals", content: "after-refusals" });
      expect((await idle.handle.waitRun(receipt.runId)).result?.output).toBe("after-refusals");
    });
    expect(f.modelCalls("refused")).toBe(0);
  } finally { await f.close(); }
});

it.each(["sdk", "daemon"] as const)("evicts saved steer aliases through their original canonical run: %s", async mode => {
  const f = await createLifecycleFixture(mode, { childBudget: { maxActiveChildren: 1 } });
  try {
    await f.inRootRun(async execution => {
      let handle: import("@vykor/agent-contracts").AgentChildHandle | undefined;
      for (let n = 0; n < 66; n++) {
        const label = `steer-held-${n}`;
        f.hold(label);
        const receipt = handle
          ? await execution.children.sendChildInput(handle.id, { content: label, delivery: "queue" })
          : await execution.children.spawnChildAgent({ prompt: label, description: "steer", agent: "worker", cwd: execution.scope.cwd, allowedTools: ["Read"] });
        handle ??= f.agent.children.get((receipt as import("@vykor/agent-contracts").AgentChildInvocation).id)!;
        await f.entered(label);
        const steers = Array.from({ length: 4 }, (_, index) => execution.children.sendChildInput(handle!.id, { id: `steer-${n}-${index}`, content: `nudge-${n}-${index}` }));
        f.release(label);
        for (const accepted of await Promise.all(steers)) expect(accepted.runId).toBe(receipt.runId);
        await handle.waitRun(receipt.runId);
      }
      const next = await execution.children.sendChildInput(handle!.id, { content: "after-steer-aliases" });
      expect((await handle!.waitRun(next.runId)).result?.output).toBe("after-steer-aliases");
    });
  } finally { await f.close(); }
}, 120_000);

it("owns the initial permit even when child.created and its first environment revocation fail", async () => {
  const f = await createLifecycleFixture("daemon", { childBudget: { maxActiveChildren: 1 }, failChildCreated: true, failLeaseReleaseOnce: true });
  try {
    await expect(f.admit("before-beginRun-fault")).rejects.toThrow("startup cleanup failed");
    const handle = f.agent.children.list()[0]!;
    expect(handle.state).toBe("closing");
    expect(handle.runId).toBeUndefined();
    let resultSettled = false;
    const preparationResult = handle.result.then(result => { resultSettled = true; return result; });
    await Promise.resolve();
    expect(resultSettled).toBe(false);
    await expect(f.admit("still-owned-before-beginRun")).rejects.toThrow("activeChildren");
    await handle.close();
    expect(await preparationResult).toMatchObject({ status: "failed", output: "injected child.created projection failure" });
    const next = await f.spawn("early-prepare-revoked");
    expect((await f.wait(next.target)).text).toBe("early-prepare-revoked");
    expect(f.modelCalls("before-beginRun-fault")).toBe(0);
  } finally { await f.close(); }
});

it("returns a stopped followup permit after its started projection is rejected", async () => {
  const f = await createLifecycleFixture("daemon", { childBudget: { maxActiveChildren: 1 }, failStartedAck: 2 });
  try {
    const a = await f.spawn("before-followup-fault"); await f.wait(a.target);
    await expect(f.sendAccepted(a.target, "followup-start-fault")).rejects.toThrow("injected started projection failure");
    const failedRunId = a.handle.runId!;
    expect((await a.handle.waitRun(failedRunId)).result?.status).toBe("failed");
    const receipt = await f.send({ ...a.target, runId: failedRunId }, "same-identity-after-ack-fault");
    expect((await f.wait({ ...a.target, runId: receipt.runId })).text).toBe("same-identity-after-ack-fault");
    const next = await f.spawn("other-identity-after-ack-fault");
    expect((await f.wait(next.target)).text).toBe("other-identity-after-ack-fault");
    expect(f.modelCalls("followup-start-fault")).toBe(0);
  } finally { await f.close(); }
});

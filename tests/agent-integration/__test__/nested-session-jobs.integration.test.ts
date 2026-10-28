import { expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AgentChildInvocation, ToolResult } from "@vykor/agent-contracts";
import { LocalTerminalProvider } from "@vykor/terminal-node";
import { decodeJobTarget } from "@vykor/protocol";
import { createLifecycleFixture, type LifecycleFixture } from "./fixtures/task-lifecycle-fixture.js";

function body(result: ToolResult) {
  return JSON.parse(result.content.find(block => block.type === "text")!.text);
}

async function spawnNested(f: LifecycleFixture, prompt: string, grandchildPrompt: string) {
  const reports = f.scriptChild(prompt, [{ name: "Agent", input: { prompt: grandchildPrompt, description: grandchildPrompt, subagentType: "worker" } }]);
  let receipt!: AgentChildInvocation;
  await f.inRootRun(async execution => {
    receipt = await execution.children.spawnChildAgent({ prompt, description: prompt, agent: "general-purpose", cwd: execution.scope.cwd, allowedTools: ["Read", "Agent", "JobList", "JobRead", "JobWait", "JobSend", "JobCancel"] });
  });
  const parent = f.agent.children.get(receipt.id)!;
  await parent.waitRun(receipt.runId);
  expect(reports).toHaveLength(1);
  expect(reports[0]!.isError).not.toBe(true);
  const target = decodeJobTarget(body(reports[0]!).target);
  if (target.kind !== "agent") throw new Error("Nested Agent must return an agent run target");
  const child = f.agent.children.get(target.jobId)!;
  return { parent, parentTarget: { kind: "agent" as const, jobId: receipt.id, runId: receipt.runId }, child, target };
}

it("routes a live child session's read, wait and cancellation to its actual grandchild despite terminal listing failure", async () => {
  const f = await createLifecycleFixture("daemon");
  const listing = vi.spyOn(LocalTerminalProvider.prototype, "list").mockRejectedValue(new Error("terminal listing failed"));
  try {
    f.hold("nested-held");
    const { parent, child, target } = await spawnNested(f, "nested-parent", "nested-held");
    await f.entered("nested-held");
    const input = { sessionId: parent.sessionId, target };
    expect((await f.application!.jobs.read(input)).snapshot.status).toBe("running");
    const waiting = f.application!.jobs.wait({ ...input, timeoutMs: 5_000 });
    expect((await f.application!.jobs.cancel(input)).status).toBe("stopping");
    expect(child.readRun(target.runId).stopping).toBe(true);
    f.release("nested-held");
    expect(await waiting).toMatchObject({ timedOut: false, snapshot: { target, status: "killed", ownerSession: parent.sessionId } });
    const list = await f.application!.jobs.list({ sessionId: parent.sessionId });
    expect(list.errors).toContainEqual({ kind: "terminal", message: "terminal listing failed" });
    expect(list.jobs.filter(job => job.kind === "agent").map(job => job.target)).toEqual([target]);
  } finally { listing.mockRestore(); await f.close(); }
});

it("keeps nested HTTP sends atomic and late controls pinned to the old run", async () => {
  const f = await createLifecycleFixture("daemon");
  try {
    const { parent, child, target } = await spawnNested(f, "nested-sender", "nested-initial");
    await child.waitRun(target.runId);
    f.hold("nested-next-a"); f.hold("nested-next-b");
    const sessionId = parent.sessionId;
    const localCatalogue = f.agent.host.resolveSessionHost(sessionId)!.plugins.createRunCapabilityView();
    await expect(f.application!.jobs.send({ sessionId, target, data: "wrong-binding-identity" }, localCatalogue)).rejects.toThrow("Child tools are not authorized");
    expect(f.modelCalls("wrong-binding-identity")).toBe(0);
    const results = await Promise.allSettled(["nested-next-a", "nested-next-b"].map(data => f.application!.jobs.send({ sessionId, target, data })));
    expect(results.filter(result => result.status === "fulfilled"), JSON.stringify(results.map(result => result.status === "rejected" ? String(result.reason) : result.value))).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    const winner = results.findIndex(result => result.status === "fulfilled");
    const accepted = results[winner]!;
    if (accepted.status !== "fulfilled" || !accepted.value) throw new Error("Expected one real run receipt");
    const next = { ...target, runId: accepted.value.runId };
    expect(next.runId).not.toBe(target.runId);
    const label = winner === 0 ? "nested-next-a" : "nested-next-b";
    await f.entered(label);
    expect((await f.application!.jobs.cancel({ sessionId, target })).status).toBe("completed");
    await expect(f.application!.jobs.send({ sessionId, target, data: "stale-followup" })).rejects.toThrow("Child run conflict");
    expect((await f.application!.jobs.read({ sessionId, target: next })).snapshot.status).toBe("running");
    expect((await f.application!.jobs.read({ sessionId, target })).text).toBe("nested-initial");
    expect(f.modelCalls("stale-followup")).toBe(0);
    f.release(label);
    expect((await f.application!.jobs.wait({ sessionId, target: next, timeoutMs: 5_000 })).snapshot.status).toBe("completed");
    const filePath = join(f.store!.sessions.get(sessionId)!.cwd, "nested-unauthorized.txt");
    const denied = f.scriptChild("nested-write-denied", [{ name: "Write", input: { file_path: filePath, content: "forbidden" } }]);
    const receipt = await f.application!.jobs.send({ sessionId, target: next, data: "nested-write-denied" });
    expect(receipt).toBeDefined();
    await child.waitRun(receipt!.runId);
    expect(denied).toHaveLength(1);
    expect(denied[0]!.content).toContainEqual({ type: "text", text: "Unknown tool: Write" });
    expect(existsSync(filePath), JSON.stringify(denied)).toBe(false);
  } finally { await f.close(); }
});

it("refuses sibling and foreign targets through the nested session's own jobs", async () => {
  const f = await createLifecycleFixture("daemon");
  const foreign = await createLifecycleFixture("daemon");
  try {
    const { parent, child, target } = await spawnNested(f, "nested-scoped", "nested-owned");
    await child.waitRun(target.runId);
    const sibling = await f.spawn("root-sibling");
    const otherRoot = await foreign.spawn("foreign-child");
    await Promise.all([sibling.handle.waitRun(sibling.target.runId), otherRoot.handle.waitRun(otherRoot.target.runId)]);
    const sessionId = parent.sessionId;
    const leases = f.environmentAcquires();
    for (const denied of [sibling.target, otherRoot.target]) {
      await expect(f.application!.jobs.read({ sessionId, target: denied })).rejects.toThrow("Job not found");
      await expect(f.application!.jobs.wait({ sessionId, target: denied, timeoutMs: 50 })).rejects.toThrow("Job not found");
      await expect(f.application!.jobs.send({ sessionId, target: denied, data: "unauthorized-followup" })).rejects.toThrow("does not accept input");
      await expect(f.application!.jobs.cancel({ sessionId, target: denied })).rejects.toThrow("Job not found");
    }
    const list = await f.application!.jobs.list({ sessionId });
    expect(list.jobs.filter(job => job.kind === "agent").map(job => job.id)).toEqual([target.jobId]);
    expect(f.agent.host.resolveSessionHost(otherRoot.handle.sessionId)).toBeUndefined();
    expect(f.environmentAcquires()).toBe(leases);
    expect(f.modelCalls("unauthorized-followup")).toBe(0);
    expect(foreign.modelCalls("unauthorized-followup")).toBe(0);
  } finally { await Promise.all([f.close(), foreign.close()]); }
});

it("reads a suspended child's archive without recreating its instance", async () => {
  const f = await createLifecycleFixture("daemon");
  try {
    const { parent, parentTarget, child, target } = await spawnNested(f, "nested-archived", "nested-archived-result");
    await child.waitRun(target.runId);
    await child.close();
    expect(await parent.requestSuspend(parentTarget.runId)).toBe(true);
    expect(parent.state).toBe("suspended");
    expect(f.agent.host.resolveSessionHost(parent.sessionId)).toBeUndefined();
    const leases = f.environmentAcquires();
    const input = { sessionId: parent.sessionId, target };
    expect((await f.application!.jobs.read(input)).text).toBe("nested-archived-result");
    expect(await f.application!.jobs.wait({ ...input, timeoutMs: 50 })).toMatchObject({ timedOut: false, snapshot: { status: "completed" } });
    expect((await f.application!.jobs.cancel(input)).status).toBe("completed");
    await expect(f.application!.jobs.send({ ...input, data: "must-not-resume" })).rejects.toThrow();
    expect(parent.state).toBe("suspended");
    expect(f.agent.host.resolveSessionHost(parent.sessionId)).toBeUndefined();
    expect(f.environmentAcquires()).toBe(leases);
    expect(f.modelCalls("must-not-resume")).toBe(0);
    await parent.close();
    expect(f.agent.host.resolveSessionHost(parent.sessionId)).toBeUndefined();
    expect((await f.application!.jobs.read(input)).text).toBe("nested-archived-result");
    expect(f.environmentAcquires()).toBe(leases);
  } finally { await f.close(); }
});

it("keeps the actual child host available until a closing descendant's invocation stops", async () => {
  const f = await createLifecycleFixture("daemon");
  try {
    f.hold("nested-closing-held");
    const { parent, child, target } = await spawnNested(f, "nested-closing-parent", "nested-closing-held");
    await f.entered("nested-closing-held");
    const closing = parent.close();
    void closing.catch(() => {});
    await vi.waitFor(() => expect(child.readRun(target.runId).stopping).toBe(true));
    expect(parent.state).toBe("closing");
    const input = { sessionId: parent.sessionId, target };
    expect((await f.application!.jobs.read(input)).snapshot.status).toBe("stopping");
    const waiting = f.application!.jobs.wait({ ...input, timeoutMs: 5_000 });
    expect((await f.application!.jobs.cancel(input)).status).toBe("stopping");
    await expect(f.application!.jobs.send({ ...input, data: "closing-must-not-start" })).rejects.toThrow("closing");
    expect(child.readRun(target.runId).result).toBeUndefined();
    f.release("nested-closing-held");
    expect(await waiting).toMatchObject({ timedOut: false, snapshot: { status: "killed" } });
    await closing;
    expect(f.agent.host.resolveSessionHost(parent.sessionId)).toBeUndefined();
    expect(f.modelCalls("closing-must-not-start")).toBe(0);
  } finally { await f.close(); }
});

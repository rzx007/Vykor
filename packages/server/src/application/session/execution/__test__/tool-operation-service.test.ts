import { afterEach, describe, expect, it, vi } from "vitest";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "@vykor/services";
import type { ToolOperationIntent } from "@vykor/agent-contracts";
import type { AgentRunCapabilitySnapshot } from "@vykor/agent-runtime";
import { ToolOperationService } from "../tool-operation-service.js";
const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).reverse().forEach(cleanup => cleanup()));
async function fixture(transactionHooks?: { beforeCommit(): void }) {
  const directory = mkdtempSync(join(tmpdir(), "tool-operation-host-"));
  const store = new SessionStore({ path: join(directory, "store.db"), transactionHooks });
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  cleanups.push(store.close.bind(store));
  const ownership = { acquire: store.acquireApplicationOwner.bind(store), release: store.releaseApplicationOwner.bind(store) };
  const lease = ownership.acquire({ ownerId: "owner", pid: process.pid, staleAfterMs: 30_000 });
  store.sessions.create({ id: "s", cwd: directory, model: "m" });
  store.runs.createRun({ id: "r", sessionId: "s" });
  store.runs.updateRun("r", { status: "running" });
  const intent: ToolOperationIntent = { scope: { sessionId: "s", agentId: "s", runId: "r", inputId: "i", traceId: "t", cwd: directory, signal: new AbortController().signal }, toolUse: { type: "tool_use", id: "call", name: "Write", input: { value: 1 } } };
  const service = new ToolOperationService({ store, ownerLease: () => lease });
  return { store, service, intent, lease, ownership };
}
async function authorized(f: Awaited<ReturnType<typeof fixture>>, intent = f.intent) {
  const operation = await f.service.operations.prepare(intent);
  const policy = await f.service.requiredPolicy.check({ intent, operation, phase: "authorization" });
  expect(policy.allowed).toBe(true);
  return { intent, operation: await f.service.operations.authorize({ intent, operation, policyVersion: policy.policyVersion }), policyVersion: policy.policyVersion };
}
describe("daemon tool operation host", () => {
  it("allows writes without copying full historical operation records for the safety check", async () => {
    const f = await fixture();
    vi.spyOn(f.store.toolOperations, "list").mockImplementation(() => { throw new Error("Full operation bodies must not be copied for safety checks"); });
    await expect(authorized(f)).resolves.toBeDefined();
  });
  it("dispatches an operation only once and creates its execution header", async () => {
    const f = await fixture(), input = await authorized(f);
    const receipt = await f.service.operations.dispatch(input);
    await expect(f.service.operations.dispatch(input)).rejects.toThrow();
    await f.service.operations.settle({ receipt, result: { content: [{ type: "text" as const, text: "done" }], toolUseId: "call", toolName: "Write" } });
    expect(f.store.toolOperations.listAttempts(input.operation.operationId)).toHaveLength(1);
    expect(f.store.executions.list({ sessionId: "s" })).toHaveLength(1);
  });
  it("blocks unknown writes across new tool call IDs and tool names", async () => {
    const f = await fixture(), first = await authorized(f);
    const receipt = await f.service.operations.dispatch(first);
    await f.service.operations.settle({ receipt, result: { content: [{ type: "text" as const, text: "timed out" }], isError: true, executionState: "unknown", toolUseId: "call", toolName: "Write" } });
    for (const name of ["Write", "OtherRoute"]) {
      const next = { ...f.intent, toolUse: { ...f.intent.toolUse, id: name, name } };
      const operation = await f.service.operations.prepare(next);
      const policy = await f.service.requiredPolicy.check({ intent: next, operation, phase: "authorization" });
      expect(policy.allowed).toBe(false);
    }
  });
  it("rejects changed runtime policy and accepts legal terminal late receipts", async () => {
    const f = await fixture(), first = await authorized(f);
    f.store.sessions.update("s", { metadata: { runtimeRevision: 1 } });
    await expect(f.service.operations.dispatch(first)).rejects.toThrow(/policy|策略/i);
    const nextIntent = { ...f.intent, toolUse: { ...f.intent.toolUse, id: "new-call" } };
    const fresh = await authorized(f, nextIntent);
    const receipt = await f.service.operations.dispatch(fresh);
    f.store.runs.updateRun("r", { status: "completed" });
    await expect(f.service.operations.settle({ receipt, result: { content: [{ type: "text" as const, text: "late" }], toolUseId: "new-call", toolName: "Write" }, late: true })).resolves.toBeUndefined();
    const next = { ...f.intent, toolUse: { ...f.intent.toolUse, id: "next" } };
    await expect(f.service.operations.prepare(next)).rejects.toThrow();
  });
  it("fences a stale owner before dispatch", async () => {
    const f = await fixture(), input = await authorized(f);
    f.ownership.release(f.lease);
    f.ownership.acquire({ ownerId: "new-owner", pid: process.pid, staleAfterMs: 30_000 });
    await expect(f.service.operations.dispatch(input)).rejects.toThrow();
    expect(f.store.toolOperations.listAttempts(input.operation.operationId)).toHaveLength(0);
  });
  it("ignores retry/read-only hints and records the actual implementation identity", async () => {
    const f = await fixture();
    const execute = async () => ({ content: [{ type: "text" as const, text: "ok" }] });
    const definition = { name: "Read", description: "spoof", inputSchema: {}, execute, safeToRetry: true, annotations: { readOnlyHint: true } };
    const binding = { definition, definitionIdentity: Symbol("real"), invoke: execute, source: { kind: "plugin" as const, id: "spoof" } };
    const intent = { ...f.intent, binding, toolUse: { ...f.intent.toolUse, name: "Read" } };
    const ticket = await f.service.operations.prepare(intent);
    expect(ticket.kind).toBe("non_replayable");
    const saved = f.store.toolOperations.get(ticket.operationId)!;
    expect(saved.toolIdentity).toContain('"kind":"plugin"');
    const replacement = { ...intent, binding: { ...binding, invoke: async () => ({ content: [{ type: "text" as const, text: "changed" }] }) } };
    await expect(f.service.operations.prepare(replacement)).rejects.toThrow(/intent conflict/);
  });
  it.each(["next", "owner"])("recovers abandoned dispatches when the next owner ID is %s without dispatching prepared work", async ownerId => {
    const f = await fixture(), first = await authorized(f);
    await f.service.operations.dispatch(first);
    const waiting = await f.service.operations.prepare({ ...f.intent, toolUse: { ...f.intent.toolUse, id: "waiting" } });
    const lease = f.ownership.acquire({ ownerId, pid: process.pid, staleAfterMs: 30_000, canTakeOver: () => true });
    expect(lease.generation).toBe(2);
    const service = new ToolOperationService({ store: f.store, ownerLease: () => lease });
    expect(service.recoverDispatching()).toBe(1);
    expect(f.store.toolOperations.get(first.operation.operationId)?.state).toBe("unknown");
    expect(f.store.toolOperations.get(waiting.operationId)?.state).toBe("prepared");
    expect(f.store.toolOperations.listAttempts(waiting.operationId)).toHaveLength(0);
  });
  it("allows only explicitly trusted read-only diagnostics past an unknown write", async () => {
    const f = await fixture(), first = await authorized(f);
    const receipt = await f.service.operations.dispatch(first);
    await f.service.operations.settle({ receipt, result: { toolUseId: "call", toolName: "Write", content: [{ type: "text" as const, text: "unknown" }], executionState: "unknown" } });
    const diagnostic = async () => ({ content: [{ type: "text" as const, text: "evidence" }] });
    const service = new ToolOperationService({ store: f.store, ownerLease: () => f.lease, describe: intent => intent.binding?.invoke === diagnostic ? { kind: "read_only" } : undefined });
    const make = (invoke: typeof diagnostic, id: string) => ({ ...f.intent, toolUse: { ...f.intent.toolUse, id, name: "Read" }, binding: { definition: { name: "Read", description: "diagnostic", inputSchema: {}, execute: invoke }, invoke, definitionIdentity: Symbol(id) } });
    const trusted = make(diagnostic, "diagnostic"), spoofed = make(async () => ({ content: [{ type: "text" as const, text: "write" }] }), "spoofed");
    const read = await service.operations.prepare(trusted);
    expect(read.kind).toBe("read_only");
    expect((await service.requiredPolicy.check({ intent: trusted, operation: read, phase: "authorization" })).allowed).toBe(true);
    const spoof = await service.operations.prepare(spoofed);
    expect(spoof.kind).toBe("non_replayable");
    expect((await service.requiredPolicy.check({ intent: spoofed, operation: spoof, phase: "authorization" })).allowed).toBe(false);
  });

  it("blocks unknown child writes through root and sibling routes while preserving unrelated roots", async () => {
    const f = await fixture();
    for (const id of ["child", "sibling", "unrelated"]) {
      f.store.sessions.create({ id, ...(id === "unrelated" ? {} : { parentId: "s" }), cwd: f.intent.scope.cwd, model: "m" });
      f.store.runs.createRun({ id: `${id}-run`, sessionId: id });
    }
    const childIntent = { ...f.intent, scope: { ...f.intent.scope, sessionId: "child", agentId: "child", runId: "child-run" } };
    const child = await authorized(f, childIntent);
    const receipt = await f.service.operations.dispatch(child);
    await f.service.operations.settle({ receipt, result: { toolUseId: "call", toolName: "Write", content: [{ type: "text" as const, text: "unknown" }], executionState: "unknown" } });
    for (const id of ["s", "sibling", "unrelated"]) {
      const intent = { ...f.intent, scope: { ...f.intent.scope, sessionId: id, agentId: id, runId: id === "s" ? "r" : `${id}-run` }, toolUse: { ...f.intent.toolUse, id: `next-${id}`, name: "OtherRoute" } };
      const operation = await f.service.operations.prepare(intent);
      expect((await f.service.requiredPolicy.check({ intent, operation, phase: "authorization" })).allowed).toBe(id === "unrelated");
    }
  });

  it("does not retain a captured scope when its execution header transaction rolls back", async () => {
    let failCommit = false;
    const f = await fixture({ beforeCommit: () => { if (failCommit) throw new Error("header commit failed"); } });
    const snapshot = { scope: f.intent.scope, capabilityView: { tools: new Map() } } as unknown as AgentRunCapabilitySnapshot;
    failCommit = true;
    expect(() => f.service.onRunCapabilities(snapshot)).toThrow("header commit failed");
    expect(f.store.executions.list()).toHaveLength(0);
    failCommit = false;
    f.store.sessions.update("s", { metadata: { runtimeRevision: 1 } });
    await expect(f.service.operations.prepare(f.intent)).resolves.toMatchObject({ state: "prepared" });
  });

  it("blocks orphaned child dispatches before restart, including a previously authorized parent", async () => {
    const f = await fixture(), parent = await authorized(f);
    for (const id of ["child", "sibling"]) {
      f.store.sessions.create({ id, parentId: "s", cwd: f.intent.scope.cwd, model: "m" });
      f.store.runs.createRun({ id: `${id}-run`, sessionId: id });
    }
    const childIntent = { ...f.intent, scope: { ...f.intent.scope, sessionId: "child", agentId: "child", runId: "child-run" } };
    const child = await authorized(f, childIntent);
    await f.service.operations.dispatch(child);
    // A receipt commit failure leaves dispatching after its Run is terminal.
    f.store.runs.updateRun("child-run", { status: "failed" });
    await expect(f.service.operations.dispatch(parent)).rejects.toThrow(/Unknown|unresolved/i);
    const sibling = { ...f.intent, scope: { ...f.intent.scope, sessionId: "sibling", agentId: "sibling", runId: "sibling-run" } };
    const operation = await f.service.operations.prepare(sibling);
    expect((await f.service.requiredPolicy.check({ intent: sibling, operation, phase: "authorization" })).allowed).toBe(false);
    expect(f.store.toolOperations.listAttempts(parent.operation.operationId)).toHaveLength(0);
  });

  it("blocks sibling dispatch immediately after a child receipt commit fails while both Runs still run", async () => {
    let failCommit = false;
    const f = await fixture({ beforeCommit: () => { if (failCommit) throw new Error("receipt commit failed"); } });
    for (const id of ["child", "sibling"]) {
      f.store.sessions.create({ id, parentId: "s", cwd: f.intent.scope.cwd, model: "m" });
      f.store.runs.createRun({ id: `${id}-run`, sessionId: id });
      f.store.runs.updateRun(`${id}-run`, { status: "running" });
    }
    const inSession = (id: string) => ({ ...f.intent, scope: { ...f.intent.scope, sessionId: id, agentId: id, runId: `${id}-run` } });
    const child = await authorized(f, inSession("child"));
    const sibling = await authorized(f, inSession("sibling"));
    const receipt = await f.service.operations.dispatch(child);
    const effectsPath = join(f.intent.scope.cwd, "effects.log");
    appendFileSync(effectsPath, "child\n");
    const result = { toolUseId: "call", toolName: "Write", content: [{ type: "text" as const, text: "written" }] };
    failCommit = true;
    await expect(f.service.operations.settle({ receipt, result })).rejects.toThrow("receipt commit failed");
    failCommit = false;
    expect(f.store.runs.getRun("child-run")?.status).toBe("running");
    expect(f.store.runs.getRun("sibling-run")?.status).toBe("running");
    await expect((async () => {
      await f.service.operations.dispatch(sibling);
      appendFileSync(effectsPath, "sibling\n");
    })()).rejects.toThrow(/Unknown|unresolved|settlement/i);
    expect(readFileSync(effectsPath, "utf8")).toBe("child\n");
    expect(f.store.toolOperations.listAttempts(sibling.operation.operationId)).toHaveLength(0);
    expect((await f.service.requiredPolicy.check({ ...sibling, phase: "dispatch" })).allowed).toBe(false);
    await expect(f.service.operations.authorize(sibling)).rejects.toThrow();
    await f.service.operations.settle({ receipt, result, late: true });
    await f.service.operations.dispatch(sibling);
    appendFileSync(effectsPath, "sibling\n");
    expect(readFileSync(effectsPath, "utf8")).toBe("child\nsibling\n");
  });

  it("keeps each failed receipt blocked until that operation is authoritatively resolved", async () => {
    let failCommit = false;
    const f = await fixture({ beforeCommit: () => { if (failCommit) throw new Error("receipt commit failed"); } });
    const first = await authorized(f);
    const second = await authorized(f, { ...f.intent, toolUse: { ...f.intent.toolUse, id: "second" } });
    const waiting = await authorized(f, { ...f.intent, toolUse: { ...f.intent.toolUse, id: "waiting" } });
    const receipt1 = await f.service.operations.dispatch(first), receipt2 = await f.service.operations.dispatch(second);
    const result1 = { toolUseId: "call", toolName: "Write", content: [{ type: "text" as const, text: "one" }] };
    const result2 = { toolUseId: "second", toolName: "Write", content: [{ type: "text" as const, text: "two" }] };
    failCommit = true;
    await expect(f.service.operations.settle({ receipt: receipt1, result: result1 })).rejects.toThrow("receipt commit failed");
    await expect(f.service.operations.settle({ receipt: receipt2, result: result2 })).rejects.toThrow("receipt commit failed");
    failCommit = false;
    await f.service.operations.settle({ receipt: receipt1, result: result1, late: true });
    await expect(f.service.operations.dispatch(waiting)).rejects.toThrow();
    await f.service.operations.settle({ receipt: receipt2, result: { ...result2, executionState: "unknown" } });
    const unresolved = f.store.toolOperations.get(second.operation.operationId)!;
    const stillUnknown = f.service.reconcile({ operationId: unresolved.operationId, expectedRevision: unresolved.revision, outcome: "unknown", evidence: "remote query unavailable" });
    await expect(f.service.operations.dispatch(waiting)).rejects.toThrow();
    f.service.reconcile({ operationId: stillUnknown.operationId, expectedRevision: stillUnknown.revision, outcome: "not_applied", evidence: "trusted remote lookup confirms no record" });
    await expect(f.service.operations.dispatch(waiting)).resolves.toMatchObject({ ownerId: "owner" });
  });

});

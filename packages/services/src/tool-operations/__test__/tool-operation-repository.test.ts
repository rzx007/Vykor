import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolExecutionResult } from "@vykor/agent-contracts/tool-data";
import type { StoredToolOperationIntent } from "../commands.js";
import { SessionStore } from "../../session-runtime/store.js";
import type { StorageContext } from "../../database/storage-context.js";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
function setup(storage: "sqlite" | "memory" = "sqlite") {
  const directory = mkdtempSync(join(tmpdir(), "vykor-operation-"));
  const path = join(directory, "sessions.db");
  const store = new SessionStore({ path });
  cleanups.push(() => {
    const target = resolve(directory), child = relative(resolve(tmpdir()), target);
    if (!child || child.startsWith("..") || isAbsolute(child) || !target.includes("vykor-operation-")) throw new Error("Unsafe temporary cleanup");
    rmSync(target, { recursive: true, force: true });
  });
  cleanups.push(() => store.close());
  store.sessions.create({ id: "s", cwd: directory, model: "m", storage });
  store.runs.createRun({ id: "r", sessionId: "s" });
  const intent: StoredToolOperationIntent = {
    scope: { sessionId: "s", runId: "r", inputId: "i", agentId: "a", cwd: directory, traceId: "t", signal: new AbortController().signal },
    toolUse: { type: "tool_use", id: "call", name: "write", input: { b: 2, a: 1 } },
  };
  return { store, path, intent };
}
const result = (state: ToolExecutionResult["executionState"] = "completed"): ToolExecutionResult => ({
  toolUseId: "call", toolName: "write", content: [{ type: "text", text: "receipt" }], executionState: state,
});
function dispatch(f: ReturnType<typeof setup>) {
  const operation = f.store.toolOperations.prepare({ ...f.intent, toolIdentity: "builtin:write:v1" });
  const authorized = f.store.toolOperations.authorize({ intent: f.intent, operation, policyVersion: "p1" });
  const receipt = f.store.toolOperations.dispatch({ intent: f.intent, operation: authorized, policyVersion: "p1", ownerId: "owner" });
  return { operation, authorized, receipt };
}
describe("tool operation repository", () => {
  it("reloads the durable ledger after acquiring ownership, including writes made after construction", () => {
    const f = setup();
    f.store.acquireApplicationOwner({ ownerId: "owner", pid: process.pid, staleAfterMs: 1000 });
    const next = new SessionStore({ path: f.path });
    cleanups.push(() => next.close());
    const { receipt } = dispatch(f);
    f.store.close();
    next.acquireApplicationOwner({ ownerId: "next", pid: process.pid, staleAfterMs: 1000, canTakeOver: () => true });
    expect(next.toolOperations.recoverDispatching()).toBe(1);
    expect(next.toolOperations.get(receipt.operationId)?.state).toBe("unknown");
    expect(next.toolOperations.listAttempts(receipt.operationId)[0]?.status).toBe("unknown");
    next.runs.createRun({ id: "next-run", sessionId: "s" });
    const intent = { ...f.intent, scope: { ...f.intent.scope, runId: "next-run" }, toolUse: { ...f.intent.toolUse, id: "new-call" } };
    const operation = next.toolOperations.prepare({ ...intent, toolIdentity: "v2" });
    const authorized = next.toolOperations.authorize({ intent, operation, policyVersion: "p1" });
    expect(() => next.toolOperations.dispatch({ intent, operation: authorized, policyVersion: "p1", ownerId: "next" })).toThrow(/unknown/i);
  });
  it("refreshes confirmed receipts on ownership acquisition while retaining local memory sessions", () => {
    const f = setup();
    f.store.acquireApplicationOwner({ ownerId: "owner", pid: process.pid, staleAfterMs: 1000 });
    const next = new SessionStore({ path: f.path });
    cleanups.push(() => next.close());
    const { receipt } = dispatch(f);
    f.store.toolOperations.settle({ receipt, result: result() });
    f.store.close();
    const lease = next.acquireApplicationOwner({ ownerId: "next", pid: process.pid, staleAfterMs: 1000, canTakeOver: () => true });
    next.sessions.create({ id: "temporary", cwd: process.cwd(), model: "m", storage: "memory" });
    next.releaseApplicationOwner(lease);
    next.acquireApplicationOwner({ ownerId: "next-again", pid: process.pid, staleAfterMs: 1000 });
    expect(next.sessions.get("temporary")?.storage).toBe("memory");
    expect(next.toolOperations.get(receipt.operationId)?.result).toEqual(result());
    expect(next.toolOperations.recoverDispatching()).toBe(0);
  });
  it("records pre-dispatch interruption as cancelled and preserves the no-start result", () => {
    const f = setup(); const operation = f.store.toolOperations.prepare({ ...f.intent, toolIdentity: "v1" });
    const interrupted = { ...result("not_started"), isError: true, failureKind: "interrupted" as const };
    f.store.toolOperations.reject({ intent: f.intent, operation, result: interrupted });
    expect(f.store.toolOperations.get(operation.operationId)?.state).toBe("cancelled");
    expect(f.store.toolOperations.get(operation.operationId)?.result).toEqual(interrupted);
    expect(f.store.toolOperations.listAttempts(operation.operationId)).toEqual([]);
    f.store.close(); const reopened = new SessionStore({ path: f.path }); cleanups.push(() => reopened.close());
    expect(reopened.toolOperations.get(operation.operationId)?.state).toBe("cancelled");
  });
  it("requires an explicit failed not_started result for a pre-dispatch rejection", () => {
    const f = setup(); const operation = f.store.toolOperations.prepare({ ...f.intent, toolIdentity: "v1" });
    expect(() => f.store.toolOperations.reject({ intent: f.intent, operation, result: result() })).toThrow(/not_started|rejection/i);
    expect(() => f.store.toolOperations.reject({ intent: f.intent, operation, result: { ...result("not_started"), isError: false } })).toThrow(/not_started|rejection/i);
    const denied = { ...result("not_started"), isError: true, failureKind: "policy" as const };
    f.store.toolOperations.reject({ intent: f.intent, operation, result: denied });
    expect(f.store.toolOperations.get(operation.operationId)?.state).toBe("rejected");
  });
  it("persists complete results, execution heads and attempts across real SQLite reopen", () => {
    const f = setup();
    const { receipt } = dispatch(f);
    f.store.toolOperations.settle({ receipt, result: result() });
    f.store.close();
    const reopened = new SessionStore({ path: f.path }); cleanups.push(() => reopened.close());
    expect(reopened.toolOperations.get(receipt.operationId)?.result).toEqual(result());
    expect(reopened.toolOperations.listAttempts(receipt.operationId)).toHaveLength(1);
    expect(reopened.executions.list({ runId: "r" })).toHaveLength(1);
  });
  it("keeps memory execution, operation and attempt collections out of SQLite", () => {
    const f = setup("memory"); const { receipt } = dispatch(f);
    f.store.toolOperations.settle({ receipt, result: result() });
    expect(f.store.toolOperations.list()).toHaveLength(1);
    const other = new SessionStore({ path: f.path }); cleanups.push(() => other.close());
    expect(other.toolOperations.list()).toEqual([]); expect(other.executions.list()).toEqual([]);
    expect((other as unknown as { storage: StorageContext }).storage.database.connection.prepare("select count(*) as n from tool_dispatch_attempt").get()).toEqual({ n: 0 });
  });
  it.each(["sqlite", "memory"] as const)("rolls %s rows and mutation buffers back when commit fails", storage => {
    const f = setup(storage);
    const context = (f.store as unknown as { storage: StorageContext }).storage;
    context.coordinator!.setHooks({ beforeCommit() { throw new Error("commit failed"); } });
    expect(() => dispatch(f)).toThrow("commit failed");
    context.coordinator!.setHooks();
    expect(f.store.toolOperations.list()).toEqual([]); expect(f.store.executions.list()).toEqual([]);
    expect(context.chatPersistence!.snapshot().toolOperations).toEqual({});
    const other = new SessionStore({ path: f.path }); cleanups.push(() => other.close());
    expect(other.toolOperations.list()).toEqual([]);
  });
  it("deduplicates the same logical call, canonicalizes keys, conflicts on changed intent and preserves independent calls", () => {
    const f = setup(); const first = f.store.toolOperations.prepare({ ...f.intent, toolIdentity: "v1" });
    expect(f.store.toolOperations.prepare({ ...f.intent, toolUse: { ...f.intent.toolUse, input: { a: 1, b: 2 } }, toolIdentity: "v1" })).toEqual(first);
    expect(() => f.store.toolOperations.prepare({ ...f.intent, toolIdentity: "v2" })).toThrow(/intent|conflict/i);
    expect(() => f.store.toolOperations.prepare({ ...f.intent, toolUse: { ...f.intent.toolUse, input: { a: 3 } }, toolIdentity: "v1" })).toThrow(/intent|conflict/i);
    const second = f.store.toolOperations.prepare({ ...f.intent, toolUse: { ...f.intent.toolUse, id: "other" }, toolIdentity: "v1" });
    expect(second.operationId).not.toBe(first.operationId); expect(second.kind).toBe("non_replayable");
  });
  it("keeps trace identifiers out of logical intent identity", () => {
    const f = setup(); const operation = f.store.toolOperations.prepare({ ...f.intent, toolIdentity: "v1" });
    expect(f.store.toolOperations.prepare({ ...f.intent, scope: { ...f.intent.scope, traceId: "new-trace" }, toolIdentity: "v1" })).toEqual(operation);
  });
  it("requires a stable business key before trusting idempotent writes", () => {
    const f = setup();
    expect(() => f.store.toolOperations.prepare({ ...f.intent, toolIdentity: "v1", kind: "idempotent_write" })).toThrow(/business key/i);
    expect(f.store.toolOperations.list()).toEqual([]);
    expect(f.store.toolOperations.prepare({ ...f.intent, toolIdentity: "v1", kind: "idempotent_write", businessKey: "job:123" }).businessKey).toBe("job:123");
  });
  it("retains every read-only reconciliation evidence item on the operation and original attempt", () => {
    const f = setup(); const { receipt } = dispatch(f); f.store.toolOperations.settle({ receipt, result: result("unknown") });
    const first = f.store.toolOperations.get(receipt.operationId)!;
    const queried = f.store.toolOperations.reconcile({ operationId: first.id, expectedRevision: first.revision, outcome: "unknown", evidence: "remote query unavailable" });
    f.store.toolOperations.reconcile({ operationId: first.id, expectedRevision: queried.revision, outcome: "not_applied", evidence: "remote request ledger: absent" });
    expect(f.store.toolOperations.get(first.id)?.reconciliations?.map(item => item.evidence)).toEqual(["remote query unavailable", "remote request ledger: absent"]);
    expect(f.store.toolOperations.listAttempts(first.id)[0]?.reconciliations?.map(item => item.outcome)).toEqual(["unknown", "not_applied"]);
  });
  it("reserves dispatch once and rejects stale revision and policy versions", () => {
    const f = setup(); const { operation, authorized } = dispatch(f);
    expect(() => f.store.toolOperations.authorize({ intent: f.intent, operation, policyVersion: "p1" })).toThrow(/revision/i);
    expect(() => f.store.toolOperations.dispatch({ intent: f.intent, operation: authorized, policyVersion: "p1", ownerId: "owner" })).toThrow();
    expect(f.store.toolOperations.listAttempts(operation.operationId)).toHaveLength(1);
  });
  it("can recheck an already authorized intent before any dispatch with the current policy version", () => {
    const f = setup(); const op = f.store.toolOperations.prepare({ ...f.intent, toolIdentity: "v1" });
    const first = f.store.toolOperations.authorize({ intent: f.intent, operation: op, policyVersion: "p1" });
    const current = f.store.toolOperations.authorize({ intent: f.intent, operation: first, policyVersion: "p2" });
    expect(current.revision).toBeGreaterThan(first.revision);
    expect(f.store.toolOperations.dispatch({ intent: f.intent, operation: current, policyVersion: "p2", ownerId: "owner" }).toolAttemptId).toBeTruthy();
    expect(f.store.toolOperations.listAttempts(op.operationId)).toHaveLength(1);
  });
  it("retains confirmed result for reuse and rejects conflicting duplicate settlement", () => {
    const f = setup(); const { receipt } = dispatch(f); f.store.toolOperations.settle({ receipt, result: result() });
    f.store.toolOperations.settle({ receipt, result: result() });
    const saved = f.store.toolOperations.prepare({ ...f.intent, toolIdentity: "builtin:write:v1" });
    expect(saved.state).toBe("confirmed"); expect(saved.result).toEqual(result());
    expect(() => f.store.toolOperations.settle({ receipt, result: { ...result(), content: [] } })).toThrow(/result|settle|receipt/i);
  });
  it("blocks unknown writes across changed tools and operation identities but permits read-only reconciliation", () => {
    const f = setup(); const { receipt } = dispatch(f); f.store.toolOperations.settle({ receipt, result: result("unknown") });
    const nextIntent = { ...f.intent, toolUse: { ...f.intent.toolUse, id: "other", name: "different-tool" } };
    const op = f.store.toolOperations.prepare({ ...nextIntent, toolIdentity: "different" });
    const auth = f.store.toolOperations.authorize({ intent: nextIntent, operation: op, policyVersion: "p1" });
    expect(() => f.store.toolOperations.dispatch({ intent: nextIntent, operation: auth, policyVersion: "p1", ownerId: "owner" })).toThrow(/unknown/i);
    const readIntent = { ...nextIntent, toolUse: { ...nextIntent.toolUse, id: "read" } };
    const read = f.store.toolOperations.prepare({ ...readIntent, toolIdentity: "read", kind: "read_only" });
    const readAuth = f.store.toolOperations.authorize({ intent: readIntent, operation: read, policyVersion: "p1" });
    expect(f.store.toolOperations.dispatch({ intent: readIntent, operation: readAuth, policyVersion: "p1", ownerId: "owner" }).toolAttemptId).toBeTruthy();
  });
  it.each(["sqlite", "memory"] as const)("allows a new %s operation when the host disables blocking without replaying the unknown operation", storage => {
    const f = setup(storage); const { receipt } = dispatch(f);
    f.store.toolOperations.settle({ receipt, result: result("unknown") });
    const unknown = f.store.toolOperations.get(receipt.operationId)!;
    const nextIntent = { ...f.intent, toolUse: { ...f.intent.toolUse, id: "next", name: "build" } };
    const prepared = f.store.toolOperations.prepare({ ...nextIntent, toolIdentity: "build-v1" });
    const authorized = f.store.toolOperations.authorize({ intent: nextIntent, operation: prepared, policyVersion: "p1" });
    expect(f.store.toolOperations.dispatch({ intent: nextIntent, operation: authorized, policyVersion: "p1", ownerId: "owner", blockOnUnknownToolOutcome: false }).toolAttemptId).toBeTruthy();
    expect(() => f.store.toolOperations.dispatch({ intent: f.intent, operation: unknown, policyVersion: "p1", ownerId: "owner", blockOnUnknownToolOutcome: false })).toThrow(/unknown/i);
    expect(f.store.toolOperations.get(receipt.operationId)).toEqual(unknown);
    expect(f.store.toolOperations.listAttempts(receipt.operationId)).toMatchObject([{ status: "unknown", result: result("unknown") }]);
    expect(f.store.toolOperations.listAttempts(receipt.operationId)).toHaveLength(1);
  });
  it("requires evidence for not_applied and uses a new attempt after current authorization", () => {
    const f = setup(); const { receipt } = dispatch(f); f.store.toolOperations.settle({ receipt, result: result("unknown") });
    let saved = f.store.toolOperations.get(receipt.operationId)!;
    expect(() => f.store.toolOperations.reconcile({ operationId: saved.id, expectedRevision: saved.revision, outcome: "not_applied", evidence: "" })).toThrow(/evidence/i);
    f.store.toolOperations.reconcile({ operationId: saved.id, expectedRevision: saved.revision, outcome: "not_applied", evidence: "host queried remote request ledger: absent" });
    saved = f.store.toolOperations.get(receipt.operationId)!;
    const auth = f.store.toolOperations.authorize({ intent: f.intent, operation: saved, policyVersion: "p2" });
    const second = f.store.toolOperations.dispatch({ intent: f.intent, operation: auth, policyVersion: "p2", ownerId: "owner" });
    expect(second.toolAttemptId).not.toBe(receipt.toolAttemptId); expect(f.store.toolOperations.listAttempts(saved.id)).toHaveLength(2);
    expect(() => f.store.toolOperations.settle({ receipt, result: result(), late: true })).toThrow();
  });
  it("recovers lost dispatches as unknown without re-execution and accepts only matching late receipts after run ends", () => {
    const f = setup(); const { receipt } = dispatch(f);
    expect(f.store.toolOperations.recoverDispatching()).toBe(1);
    expect(f.store.toolOperations.get(receipt.operationId)?.state).toBe("unknown");
    f.store.runs.updateRun("r", { status: "completed" });
    expect(() => f.store.toolOperations.settle({ receipt: { ...receipt, ownerId: "forged" }, result: result(), late: true })).toThrow();
    expect(() => f.store.toolOperations.settle({ receipt, result: { ...result(), toolUseId: "forged" }, late: true })).toThrow();
    f.store.toolOperations.settle({ receipt, result: result(), late: true });
    expect(f.store.toolOperations.get(receipt.operationId)?.state).toBe("confirmed");
  });
  it("fences stale owners before any operation mutation", () => {
    const f = setup(); const owner = f.store.acquireApplicationOwner({ ownerId: "owner", pid: process.pid, staleAfterMs: 1000 });
    const { receipt } = dispatch(f);
    const takeover = new SessionStore({ path: f.path }); cleanups.push(() => takeover.close());
    takeover.acquireApplicationOwner({ ownerId: "new", pid: process.pid, staleAfterMs: 1000, canTakeOver: () => true });
    expect(() => f.store.toolOperations.settle({ receipt, result: result() })).toThrow(/owned/i);
    expect(() => f.store.toolOperations.prepare({ ...f.intent, toolIdentity: "builtin:write:v1" })).toThrow(/owned/i);
    expect(owner.ownerId).toBe("owner");
  });
  it("deletes all operation collections with the session and retains unresolved records under ordinary retention", () => {
    const f = setup(); const { receipt } = dispatch(f); f.store.toolOperations.settle({ receipt, result: result("unknown") });
    f.store.applyRetention(); expect(f.store.toolOperations.get(receipt.operationId)?.state).toBe("unknown");
    f.store.conversationTransactions.deleteSessionTree("s");
    expect(f.store.toolOperations.list()).toEqual([]); expect(f.store.executions.list()).toEqual([]);
    const other = new SessionStore({ path: f.path }); cleanups.push(() => other.close());
    expect(other.toolOperations.list()).toEqual([]);
  });
  it("mirrors Run lifecycle on Execution heads without clearing unresolved operations", () => {
    const f = setup(); const { receipt } = dispatch(f);
    f.store.toolOperations.settle({ receipt, result: result("unknown") });
    f.store.runs.updateRun("r", { status: "running" });
    expect(f.store.executions.list({ runId: "r" })[0]?.status).toBe("running");
    f.store.runs.updateRun("r", { status: "interrupted" });
    const execution = f.store.executions.list({ runId: "r" })[0]!;
    expect(execution.status).toBe("interrupted"); expect(execution.finishedAt).toBeTypeOf("number");
    expect(f.store.toolOperations.get(receipt.operationId)?.state).toBe("unknown");
    f.store.close(); const other = new SessionStore({ path: f.path }); cleanups.push(() => other.close());
    expect(other.executions.get(execution.id)?.status).toBe("interrupted");
  });
  it.each(["sqlite", "memory"] as const)("rolls back %s dispatch and settlement without losing the earlier receipt", storage => {
    const f = setup(storage);
    const op = f.store.toolOperations.prepare({ ...f.intent, toolIdentity: "v1" });
    const auth = f.store.toolOperations.authorize({ intent: f.intent, operation: op, policyVersion: "p1" });
    const context = (f.store as unknown as { storage: StorageContext }).storage;
    context.coordinator!.setHooks({ beforeCommit() { throw new Error("commit failed"); } });
    expect(() => f.store.toolOperations.dispatch({ intent: f.intent, operation: auth, policyVersion: "p1", ownerId: "owner" })).toThrow("commit failed");
    expect(f.store.toolOperations.get(op.operationId)?.state).toBe("authorized"); expect(f.store.toolOperations.listAttempts(op.operationId)).toEqual([]);
    context.coordinator!.setHooks();
    const receipt = f.store.toolOperations.dispatch({ intent: f.intent, operation: auth, policyVersion: "p1", ownerId: "owner" });
    context.coordinator!.setHooks({ beforeCommit() { throw new Error("commit failed"); } });
    expect(() => f.store.toolOperations.settle({ receipt, result: result() })).toThrow("commit failed");
    context.coordinator!.setHooks();
    expect(f.store.toolOperations.get(op.operationId)?.state).toBe("dispatching"); expect(f.store.toolOperations.listAttempts(op.operationId)[0]?.result).toBeUndefined();
    f.store.toolOperations.settle({ receipt, result: result() });
    expect(f.store.toolOperations.get(op.operationId)?.state).toBe("confirmed");
  });
  it("rejects changed policy, scope, owner and terminal Run before reserving an attempt", () => {
    const f = setup(); const op = f.store.toolOperations.prepare({ ...f.intent, toolIdentity: "v1" });
    const auth = f.store.toolOperations.authorize({ intent: f.intent, operation: op, policyVersion: "p1" });
    expect(() => f.store.toolOperations.dispatch({ intent: f.intent, operation: auth, policyVersion: "p2", ownerId: "owner" })).toThrow(/policy/i);
    expect(() => f.store.toolOperations.dispatch({ intent: { ...f.intent, scope: { ...f.intent.scope, inputId: "forged" } }, operation: auth, policyVersion: "p1", ownerId: "owner" })).toThrow(/intent/i);
    f.store.acquireApplicationOwner({ ownerId: "owner", pid: process.pid, staleAfterMs: 1000 });
    expect(() => f.store.toolOperations.dispatch({ intent: f.intent, operation: auth, policyVersion: "p1", ownerId: "forged" })).toThrow(/owner/i);
    f.store.runs.updateRun("r", { status: "completed" });
    expect(() => f.store.toolOperations.dispatch({ intent: f.intent, operation: auth, policyVersion: "p1", ownerId: "owner" })).toThrow(/terminal/i);
    expect(f.store.toolOperations.listAttempts(op.operationId)).toEqual([]);
  });
  it("blocks a new Run when a terminal Run still has an unsettled dispatch", () => {
    const f = setup(); dispatch(f);
    f.store.runs.updateRun("r", { status: "failed" });
    f.store.runs.createRun({ id: "new-run", sessionId: "s" });
    const intent = { ...f.intent, scope: { ...f.intent.scope, runId: "new-run" }, toolUse: { ...f.intent.toolUse, id: "new-call" } };
    const op = f.store.toolOperations.prepare({ ...intent, toolIdentity: "v1" });
    const auth = f.store.toolOperations.authorize({ intent, operation: op, policyVersion: "p1" });
    expect(() => f.store.toolOperations.dispatch({ intent, operation: auth, policyVersion: "p1", ownerId: "owner" })).toThrow(/unsettled|unknown/i);
    expect(f.store.toolOperations.listAttempts(op.operationId)).toEqual([]);
  });
});

it("keeps applied reconciliation unknown when its result omits executionState and preserves evidence after reopen", () => {
  const f = setup(), { receipt } = dispatch(f);
  f.store.toolOperations.settle({ receipt, result: result("unknown") });
  const before = f.store.toolOperations.get(receipt.operationId)!;
  const { executionState: _state, ...unspecified } = result();
  const reviewed = f.store.toolOperations.reconcile({ operationId: before.operationId, expectedRevision: before.revision, outcome: "applied", evidence: "record exists but execution completion cannot be verified", result: unspecified });
  expect(reviewed.state).toBe("unknown");
  f.store.close();
  const reopened = new SessionStore({ path: f.path }); cleanups.push(() => reopened.close());
  expect(reopened.toolOperations.get(before.operationId)).toMatchObject({ state: "unknown", reconciliations: [{ outcome: "applied", evidence: "record exists but execution completion cannot be verified" }], result: { executionState: "unknown" } });
  expect(reopened.toolOperations.listAttempts(before.operationId)).toMatchObject([{ status: "unknown", result: { executionState: "unknown" }, reconciliations: [{ outcome: "applied" }] }]);
});

it("accepts the same attempt's real late completion after manual not_applied and retains review history", () => {
  const f = setup(), { receipt } = dispatch(f);
  f.store.toolOperations.settle({ receipt, result: result("unknown") });
  const before = f.store.toolOperations.get(receipt.operationId)!;
  f.store.toolOperations.reconcile({ operationId: before.operationId, expectedRevision: before.revision, outcome: "not_applied", evidence: "remote observation was absent before completion" });
  f.store.runs.updateRun("r", { status: "failed" });
  expect(() => f.store.toolOperations.settle({ receipt: { ...receipt, revision: receipt.revision + 1 }, result: result(), late: true })).toThrow(/receipt/i);
  expect(() => f.store.toolOperations.settle({ receipt: { ...receipt, ownerId: "other" }, result: result(), late: true })).toThrow(/receipt/i);
  expect(() => f.store.toolOperations.settle({ receipt, result: { ...result(), toolUseId: "other" }, late: true })).toThrow(/identity/i);
  f.store.toolOperations.settle({ receipt, result: result(), late: true });
  expect(f.store.toolOperations.get(before.operationId)).toMatchObject({ state: "confirmed", activeAttemptId: receipt.toolAttemptId, result: { executionState: "completed" }, reconciliations: [{ outcome: "not_applied" }] });
  expect(f.store.toolOperations.listAttempts(before.operationId)).toMatchObject([{ id: receipt.toolAttemptId, status: "confirmed", result: { executionState: "completed" }, reconciliations: [{ outcome: "not_applied" }] }]);
  f.store.close();
  const reopened = new SessionStore({ path: f.path }); cleanups.push(() => reopened.close());
  expect(reopened.toolOperations.get(before.operationId)).toMatchObject({ state: "confirmed", result: { executionState: "completed" }, reconciliations: [{ outcome: "not_applied" }] });
});

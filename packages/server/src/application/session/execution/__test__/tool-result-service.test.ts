import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRunScope, RunToolBinding } from "@vykor/agent-contracts";
import { SessionStore, ToolResultReader } from "@vykor/services";
import { markToolResultReader, toolDefinitionIdentity } from "@vykor/core";
import { createToolResultTool } from "@vykor/tools";
import { ToolResultService } from "../tool-result-service.js";
const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).reverse().forEach(fn => fn()));
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "tool-result-service-")), store = new SessionStore({ path: join(directory, "state.db") });
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }), () => store.close());
  const lease = store.acquireApplicationOwner({ ownerId: "owner", pid: process.pid, staleAfterMs: 30_000 });
  store.sessions.create({ id: "s", cwd: directory, model: "m" });
  store.runs.createRun({ id: "r", sessionId: "s" }); store.runs.updateRun("r", { status: "running" });
  const controller = new AbortController();
  const scope: AgentRunScope = { agentId: "s", sessionId: "s", runId: "r", cwd: directory, traceId: "t", inputId: "i", signal: controller.signal };
  const invoke = async () => ({ content: [] });
  const binding: RunToolBinding = { definition: { name: "Read", description: "read", inputSchema: {}, execute: invoke }, invoke, source: { kind: "plugin", id: "selected" } };
  const bindings = new Map([["Read", binding]]);
  const intent = { scope, toolUse: { type: "tool_use" as const, id: "call", name: "Read", input: {} } };
  const operation = store.toolOperations.prepare({ ...intent, toolIdentity: JSON.stringify({ source: binding.source, implementation: "old-process-function-id" }) });
  const authorized = store.toolOperations.authorize({ intent, operation, policyVersion: "p" });
  const receipt = store.toolOperations.dispatch({ intent, operation: authorized, policyVersion: "p", ownerId: "owner" });
  const result = { operationId: operation.operationId, toolUseId: "call", toolName: "Read", executionState: "completed" as const, content: [{ type: "text" as const, text: "x".repeat(300_000) + "TAIL" }] };
  store.toolOperations.settle({ receipt, result });
  const service = new ToolResultService({ store, ownerLease: () => lease });
  return { store, service, scope, bindings, binding, result, lease, controller };
}
describe("host-bound historical tool result access", () => {
  it("excludes a captured builtin reader's saved operations from list, read and search after restart", async () => {
    const f = fixture();
    const definition = markToolResultReader(createToolResultTool());
    const source = { kind: "builtin" as const };
    const binding = { definition: Object.freeze({ ...definition }), definitionIdentity: toolDefinitionIdentity(definition), invoke: definition.execute, source };
    const intent = { scope: f.scope, toolUse: { type: "tool_use" as const, id: "reader", name: "ToolResult", input: { action: "list" } } };
    const operation = f.store.toolOperations.prepare({ ...intent, kind: "read_only", toolIdentity: JSON.stringify({ source, implementation: "old-reader-function" }) });
    const authorized = f.store.toolOperations.authorize({ intent, operation, policyVersion: "p" });
    const receipt = f.store.toolOperations.dispatch({ intent, operation: authorized, policyVersion: "p", ownerId: "owner" });
    const result = { operationId: operation.operationId, toolUseId: "reader", toolName: "ToolResult", executionState: "completed" as const, content: [{ type: "text" as const, text: "reader query output" }] };
    f.store.toolOperations.settle({ receipt, result });
    const ref = new ToolResultReader(f.store.toolOperations).retain("s", "r", result);
    const view = f.service.forRun(f.scope, new Map([["ToolResult", binding]]));
    expect((await view.list()).items).toEqual([]);
    await expect(view.read({ id: ref.id })).rejects.toThrow(/authorized/i);
    await expect(view.search({ id: ref.id, query: "reader" })).rejects.toThrow(/authorized/i);

    const replacement = { ...binding, source: { kind: "agent" as const }, definition: { ...definition, execute: async () => ({ content: [] }) }, definitionIdentity: Symbol("replacement") };
    const replaced = f.service.forRun(f.scope, new Map([["ToolResult", replacement]]));
    expect((await replaced.list()).items).toEqual([]);
    await expect(replaced.read({ id: ref.id })).rejects.toThrow(/authorized/i);

    const ownIntent = { ...intent, toolUse: { ...intent.toolUse, id: "replacement" } };
    const own = f.store.toolOperations.prepare({ ...ownIntent, toolIdentity: JSON.stringify({ source: replacement.source }) });
    const ownAuthorized = f.store.toolOperations.authorize({ intent: ownIntent, operation: own, policyVersion: "p" });
    const ownReceipt = f.store.toolOperations.dispatch({ intent: ownIntent, operation: ownAuthorized, policyVersion: "p", ownerId: "owner" });
    const ownResult = { ...result, toolUseId: "replacement", operationId: own.operationId, content: [{ type: "text" as const, text: "ordinary same-name result" }] };
    f.store.toolOperations.settle({ receipt: ownReceipt, result: ownResult });
    const ownRef = await replaced.retain(ownResult);
    expect((await replaced.list()).items).toEqual([ownRef]);
    expect((await replaced.read({ id: ownRef.id })).text).toBe("ordinary same-name result");
  });
  it("permits historical source reads through a fresh actual binding and lists after a later Run", async () => {
    const f = fixture(), run = f.service.forRun(f.scope, f.bindings), ref = await run.retain(f.result);
    f.store.runs.updateRun("r", { status: "completed" });
    f.store.runs.createRun({ id: "later", sessionId: "s" });
    const freshInvoke = async () => ({ content: [] });
    const later = f.service.forRun({ ...f.scope, runId: "later" }, new Map([["Read", { ...f.binding, invoke: freshInvoke, definitionIdentity: Symbol("fresh") }]]));
    expect((await later.list()).items).toEqual([ref]);
    expect((await later.read({ id: ref.id, offset: 300_000 })).text).toBe("TAIL");
    await expect(run.read({ id: ref.id })).rejects.toThrow(/terminal|active|current/i);
  });
  it("denies siblings and parents regardless of their authorized matching tool names", async () => {
    const f = fixture(), ref = await f.service.forRun(f.scope, f.bindings).retain(f.result);
    for (const sessionId of ["child", "sibling", "parent"]) {
      f.store.sessions.create({ id: sessionId, ...(sessionId === "parent" ? {} : { parentId: "s" }), cwd: f.scope.cwd, model: "m" });
      f.store.runs.createRun({ id: `${sessionId}-run`, sessionId });
      const view = f.service.forRun({ ...f.scope, agentId: sessionId, sessionId, runId: `${sessionId}-run` }, f.bindings);
      expect((await view.list()).items).toEqual([]);
      await expect(view.read({ id: ref.id })).rejects.toThrow();
    }
  });
  it("filters unselected or replaced sources, ignores forged refs and denies current binding revocation", async () => {
    const f = fixture(), run = f.service.forRun(f.scope, f.bindings), ref = await run.retain({ ...f.result, resultRef: { id: "forged", toolName: "Read", totalChars: 0 } });
    expect(ref.id).not.toBe("forged");
    for (const bindings of [new Map(), new Map([["Read", { ...f.binding, source: { kind: "plugin" as const, id: "not-selected" } }]]), new Map([["Read", { ...f.binding, source: { kind: "builtin" as const } }]])]) {
      const view = f.service.forRun(f.scope, bindings);
      expect((await view.list()).items).toEqual([]);
      await expect(view.search({ id: ref.id, query: "TAIL" })).rejects.toThrow();
    }
    f.bindings.delete("Read");
    await expect(run.read({ id: ref.id })).rejects.toThrow();
  });
  it.each(["revision", "terminal", "abort", "owner", "session"])("rejects access after %s changes", async reason => {
    const f = fixture(), view = f.service.forRun(f.scope, f.bindings), ref = await view.retain(f.result);
    if (reason === "revision") f.store.sessions.update("s", { metadata: { runtimeRevision: 1 } });
    if (reason === "terminal") f.store.runs.updateRun("r", { status: "completed" });
    if (reason === "abort") f.controller.abort();
    if (reason === "owner") { f.store.releaseApplicationOwner(f.lease); f.store.acquireApplicationOwner({ ownerId: "replacement", pid: process.pid, staleAfterMs: 30_000 }); }
    if (reason === "session") f.store.sessions.archive("s");
    await expect(view.list()).rejects.toThrow();
    await expect(view.read({ id: ref.id })).rejects.toThrow();
  });
  it("checks actual scope ownership and refuses mismatched source claims or unpersisted results", async () => {
    const f = fixture();
    expect(() => f.service.forRun({ ...f.scope, agentId: "other" }, f.bindings)).toThrow();
    expect(() => f.service.forRun({ ...f.scope, cwd: "/forged" }, f.bindings)).toThrow();
    const view = f.service.forRun(f.scope, f.bindings);
    await expect(view.retain(f.result, { kind: "builtin" })).rejects.toThrow();
    await expect(view.retain({ ...f.result, operationId: "operation_missing" })).rejects.toThrow();
  });
});

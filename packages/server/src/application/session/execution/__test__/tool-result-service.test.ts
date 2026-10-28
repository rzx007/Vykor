import { afterEach, describe, expect, it, vi } from "vitest";
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
  const result = { toolUseId: "call", toolName: "Read", executionState: "completed" as const, content: [{ type: "text" as const, text: "x".repeat(300_000) + "TAIL" }] };
  const service = new ToolResultService({ store, ownerLease: () => lease });
  return { store, service, scope, bindings, binding, result, lease, controller };
}
describe("host-bound historical tool result access", () => {
  it("lists authorized metadata without loading bodies", async () => {
    const f = fixture(), view = f.service.forRun(f.scope, f.bindings), ref = await view.retain(f.result);
    const read = vi.spyOn(f.store.toolResults, "readText");
    expect(await view.list({ limit: 1 })).toEqual({ items: [ref] });
    expect(await f.service.forRun(f.scope, new Map()).list()).toEqual({ items: [] });
    expect(read).not.toHaveBeenCalled();
    expect((await view.read({ id: ref.id, offset: 300_000 })).text).toBe("TAIL");
    expect(read).toHaveBeenCalledTimes(1);
  });
  it("does not recursively save the captured result reader", async () => {
    const f = fixture(), definition = markToolResultReader(createToolResultTool());
    const binding = { definition, definitionIdentity: toolDefinitionIdentity(definition), invoke: definition.execute, source: { kind: "builtin" as const } };
    const view = f.service.forRun(f.scope, new Map([["ToolResult", binding]]));
    await expect(view.retain({ ...f.result, toolName: "ToolResult" })).rejects.toThrow();
    expect((await view.list()).items).toEqual([]);
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
  it("checks actual scope ownership and refuses mismatched source claims or incomplete results", async () => {
    const f = fixture();
    expect(() => f.service.forRun({ ...f.scope, agentId: "other" }, f.bindings)).toThrow();
    expect(() => f.service.forRun({ ...f.scope, cwd: "/forged" }, f.bindings)).toThrow();
    const view = f.service.forRun(f.scope, f.bindings);
    await expect(view.retain(f.result, { kind: "builtin" })).rejects.toThrow();
    await expect(view.retain({ ...f.result, executionState: "unknown" })).rejects.toThrow();
  });
});

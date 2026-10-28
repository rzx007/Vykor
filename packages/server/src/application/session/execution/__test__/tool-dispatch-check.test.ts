import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionStore } from "@vykor/services";
import { QueryEngine, ToolRegistry } from "@vykor/core";
import { bindToolDispatchCheck } from "../tool-dispatch-check.js";
const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).reverse().forEach(fn => fn()));
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "dispatch-check-")), store = new SessionStore({ path: join(directory, "state.db") });
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }), () => store.close());
  const lease = store.acquireApplicationOwner({ ownerId: "owner", pid: process.pid, staleAfterMs: 30000 });
  store.sessions.create({ id: "s", cwd: directory, model: "m" });
  store.conversationTransactions.admitPrompt({ id: "i", sessionId: "s", items: [{ type: "text", text: "work" }] });
  store.runs.createRun({ id: "r", sessionId: "s", inputId: "i" });
  const controller = new AbortController();
  const scope = { agentId: "s", sessionId: "s", runId: "r", inputId: "i", traceId: "t", cwd: directory, signal: controller.signal };
  let effects = 0;
  const definition = { name: "Write", description: "fixture", inputSchema: { type: "object" }, execute: async () => { effects++; return { content: [{ type: "text" as const, text: "done" }] }; } };
  const binding = { definition, invoke: definition.execute, source: { kind: "plugin" as const, id: "selected" } };
  const tools = new Map([["Write", binding]]), registry = new ToolRegistry(); registry.register(definition, binding.source);
  const check = bindToolDispatchCheck({ store, ownerLease: () => lease, accepting: () => true })(scope, tools);
  const execution = { scope, tools, checkToolDispatch: check, effects: { requestPermission: async () => ({ status: "approved" as const }) }, children: {} as any, emit: async () => {}, takeSteeredInputs: async () => [], closeSteering() {}, observeInvocation() {} };
  const engine = new QueryEngine({ async *streamMessage() {} }, registry, { checkTool: async () => ({ action: "allow" }) }, { register() {}, execute: async () => ({ blocked: false }) }, { cwd: directory });
  return { store, scope, binding, execution, lease, effects: () => effects, run: () => engine.executeTool({ type: "tool_use", id: "call", name: "Write", input: {} }, { execution }) };
}
describe("live host checks before actual dispatch", () => {
  it.each(["owner", "terminal", "revision", "source", "definition", "invoke", "input", "cwd"])("rejects changed %s before any actual tool effect", async reason => {
    const f = fixture();
    if (reason === "owner") { f.store.releaseApplicationOwner(f.lease); f.store.acquireApplicationOwner({ ownerId: "other", pid: process.pid, staleAfterMs: 30000 }); }
    if (reason === "terminal") f.store.runs.updateRun("r", { status: "completed" });
    if (reason === "revision") f.store.sessions.update("s", { metadata: { runtimeRevision: 1 } });
    if (reason === "source") f.binding.source.id = "forged";
    if (reason === "definition") f.binding.definition = { ...f.binding.definition };
    if (reason === "invoke") f.binding.invoke = async () => ({ content: [] });
    if (reason === "input") f.scope.inputId = "other";
    if (reason === "cwd") f.scope.cwd = "/other";
    await expect(f.run()).rejects.toThrow(); expect(f.effects()).toBe(0);
  });
  it("allows an unchanged live binding without creating any execution record", async () => {
    const f = fixture(); expect(await f.run()).toMatchObject({ executionState: "completed" }); expect(f.effects()).toBe(1);
    expect(f.store.toolResults.list("s")).toEqual([]);
  });
});

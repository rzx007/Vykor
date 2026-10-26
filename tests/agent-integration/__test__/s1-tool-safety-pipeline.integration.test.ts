import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentExecutionContext, StreamingMessageClient, ToolDefinition, ToolResult } from "@vykor/agent-contracts";
import { QueryEngine, ToolRegistry } from "@vykor/core";
import { SessionStore } from "@vykor/services";
import { ToolOperationService } from "../../../packages/server/src/application/session/execution/tool-operation-service.js";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const dispose of cleanup.splice(0).reverse()) dispose(); });

const success: ToolResult = { content: [{ type: "text", text: "external receipt" }], executionState: "completed" };

function fixture(options: { invoke?(): Promise<ToolResult>; timeoutMs?: number; failReceiptCommit?: boolean; client?: StreamingMessageClient } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "vykor-s1-pipeline-"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  let effects = 0;
  const store = new SessionStore({ path: join(directory, "session.db"), transactionHooks: {
    beforeCommit() { if (options.failReceiptCommit && effects > 0) throw new Error("receipt commit unavailable"); },
  } });
  cleanup.push(() => store.close());
  const lease = store.acquireApplicationOwner({ ownerId: "pipeline-owner", pid: process.pid, staleAfterMs: 60_000 });
  store.sessions.create({ id: "session", cwd: directory, model: "offline" });
  store.runs.createRun({ id: "run", sessionId: "session" });
  store.runs.updateRun("run", { status: "running" });
  const tool: ToolDefinition = { name: "ExternalWrite", description: "controlled external effect", inputSchema: {
    type: "object", properties: { text: { type: "string" } }, required: ["text"],
  }, execute: async () => { effects++; return options.invoke ? await options.invoke() : structuredClone(success); } };
  const registry = new ToolRegistry();
  registry.register(tool, { kind: "builtin" });
  const service = new ToolOperationService({ store, ownerLease: () => lease });
  const scope = { agentId: "session", sessionId: "session", runId: "run", inputId: "input", cwd: directory,
    traceId: "trace", signal: new AbortController().signal };
  const execution: AgentExecutionContext = { scope, toolSafety: service,
    tools: new Map([[tool.name, { definition: tool, source: { kind: "builtin" }, invoke: tool.execute }]]),
    effects: { requestPermission: async () => ({ status: "approved" }) },
    children: { hasChildAgent: () => false, spawnChildAgent: async () => { throw new Error("unexpected child"); },
      sendChildInput: async () => { throw new Error("unexpected child"); }, interruptChildAgent: async () => {},
      awaitChildAgent: async () => { throw new Error("unexpected child"); } },
    emit: async () => {}, takeSteeredInputs: async () => [], closeSteering() {},
  };
  const engine = new QueryEngine(options.client ?? { streamMessage: async function* () { throw new Error("unexpected model call"); } }, registry,
    { checkTool: async () => ({ action: "allow" }) }, { register() {}, execute: async () => ({ blocked: false }) },
    { cwd: directory, toolTimeoutMs: options.timeoutMs });
  const execute = (id = "call") => engine.executeTool({ type: "tool_use", id, name: tool.name, input: { text: "value" } }, { execution });
  return { store, service, execution, engine, execute, effects: () => effects };
}

describe("core and daemon S1 contract through real SQLite", () => {
  it("keeps equal provider call IDs in separate model generations independent", async () => {
    let generations = 0;
    const f = fixture({ client: { async *streamMessage() {
      if (++generations <= 2) {
        yield { type: "tool_use_start", toolUse: { type: "tool_use", id: "call_1", name: "ExternalWrite", input: { text: "value" } } };
        yield { type: "complete", stopReason: "tool_use" };
      } else yield { type: "complete", stopReason: "end_turn" };
    } } });
    for await (const _event of f.engine.submitMessage("write twice", { execution: f.execution })) { /* drain */ }
    expect(generations).toBe(3);
    expect(f.effects()).toBe(2);
    expect(f.store.toolOperations.list()).toHaveLength(2);
  });
  it("persists policy rejection without creating a dispatch attempt", async () => {
    const f = fixture();
    f.service.requiredPolicy.check = async () => { throw new Error("policy offline"); };
    const result = await f.execute();
    expect(result.executionState).toBe("not_started");
    expect(result.toolAttemptId).toBeUndefined();
    expect(f.effects()).toBe(0);
    const [operation] = f.store.toolOperations.list({ sessionId: "session" });
    expect(operation!.state).toBe("rejected");
    expect(f.store.toolOperations.listAttempts(operation!.id)).toEqual([]);
  });

  it("reuses a confirmed call but preserves independent equal-parameter operations", async () => {
    const f = fixture();
    const first = await f.execute();
    const replay = await f.execute();
    expect(f.effects()).toBe(1);
    expect(replay).toEqual(first);
    expect(first.toolAttemptId).not.toBe("tool_attempt_call_1");
    const independent = await f.execute("different-call");
    expect(f.effects()).toBe(2);
    expect(independent.operationId).not.toBe(first.operationId);
    expect(f.store.toolOperations.list()).toHaveLength(2);
  });

  it("keeps a dispatched operation unresolved if receipt commit fails and prevents later effects", async () => {
    const f = fixture({ failReceiptCommit: true });
    await expect(f.execute()).rejects.toThrow("receipt commit unavailable");
    expect(f.effects()).toBe(1);
    expect(f.store.toolOperations.list()[0]!.state).toBe("dispatching");
    await expect(f.execute("new-call")).rejects.toThrow();
    expect(f.effects()).toBe(1);
  });

  it("audits a late receipt after timeout without reopening the terminal Run", async () => {
    let release!: (result: ToolResult) => void;
    const returned = new Promise<ToolResult>(resolve => { release = resolve; });
    const f = fixture({ timeoutMs: 15, invoke: () => returned });
    await expect(f.execute()).rejects.toThrow(/unknown outcome/);
    expect(f.effects()).toBe(1);
    expect(f.store.toolOperations.list()[0]!.state).toBe("unknown");
    f.store.runs.updateRun("run", { status: "interrupted" });
    release(structuredClone(success));
    await vi.waitFor(() => expect(f.store.toolOperations.list()[0]!.state).toBe("confirmed"));
    expect(f.store.runs.getRun("run")!.status).toBe("interrupted");
    expect(f.store.toolOperations.listAttempts(f.store.toolOperations.list()[0]!.id)).toHaveLength(1);
    expect(f.effects()).toBe(1);
  });
});

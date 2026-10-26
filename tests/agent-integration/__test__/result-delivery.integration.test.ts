import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentEvent, AgentOutputContract, Message, StreamingMessageClient, ToolDefinition, ToolExecutionResult } from "@vykor/agent-contracts";
import { createAgentKernel } from "@vykor/agent-runtime/kernel";
import { isToolResultReader, markToolResultReader, QueryEngine, ToolRegistry } from "@vykor/core";
import { SessionStore } from "@vykor/services";
import { createToolResultTool } from "@vykor/tools";
import { createRunCapabilityView } from "../../../packages/agent-runtime/src/node/plugins/run-capability-view.js";
import { ToolOperationService } from "../../../packages/server/src/application/session/execution/tool-operation-service.js";
import { ToolResultService } from "../../../packages/server/src/application/session/execution/tool-result-service.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });
const schema = { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false };
const delivery = { status: "done", summary: "Report ready", data: { path: "report.md" } };
const ids = { runId: "run", inputId: "input", traceId: "trace" };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}
type Call = { id: string; name: string; input: Record<string, unknown> };
function ledger(store: SessionStore) {
  return store.toolOperations.list({ sessionId: "session" }).map(row => ({
    call: row.toolCallId, state: row.state, result: row.result,
    attempts: store.toolOperations.listAttempts(row.id),
  }));
}
async function fixture(options: {
  contract(directory: string): AgentOutputContract;
  next(request: number, messages: readonly Message[], store: SessionStore): Call | undefined;
}) {
  const directory = mkdtempSync(join(tmpdir(), "vykor-result-delivery-"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const store = new SessionStore({ path: join(directory, "session.db") });
  cleanup.push(() => store.close());
  const lease = store.acquireApplicationOwner({ ownerId: "delivery-owner", pid: process.pid, staleAfterMs: 60_000 });
  store.sessions.create({ id: "session", cwd: directory, model: "offline" });
  store.conversationTransactions.admitPrompt({ id: ids.inputId, sessionId: "session", items: [{ type: "text", text: "Create a verified report" }] });
  store.runs.createRun({ id: ids.runId, inputId: ids.inputId, sessionId: "session" });
  const events: AgentEvent[] = [], registry = new ToolRegistry();
  const repair: ToolDefinition = {
    name: "RepairReport", description: "Write the actual report checked by the host", inputSchema: { type: "object", additionalProperties: false },
    execute: async () => { writeFileSync(join(directory, "report.md"), "verified report\n"); return { content: [{ type: "text", text: "Report saved" }], executionState: "completed" }; },
  };
  registry.register(repair, { kind: "builtin" });
  registry.register(markToolResultReader(createToolResultTool()), { kind: "builtin" });
  const operations = new ToolOperationService({ store, ownerLease: () => lease, describe: intent => {
    const binding = intent.binding;
    return binding?.source?.kind === "builtin" && isToolResultReader(binding.definition, binding.definitionIdentity) ? { kind: "read_only" } : undefined;
  } });
  const results = new ToolResultService({ store, ownerLease: () => lease });
  let requests = 0;
  const client: StreamingMessageClient = { async *streamMessage(params) {
    const call = options.next(++requests, params.messages, store);
    if (!call) { yield { type: "complete", stopReason: "end_turn" }; return; }
    yield { type: "tool_use_start", toolUse: { type: "tool_use", ...call } };
    yield { type: "complete", stopReason: "tool_use" };
  } };
  const engine = new QueryEngine(client, registry,
    { checkTool: async () => ({ action: "allow" }) }, { execute: async () => ({ blocked: false }) },
    { cwd: directory, sessionId: "session", maxTurns: 6, trajectoryTrackerFactory: false, toolTimeoutMs: 10_000, modelRetry: { maxTotalRetries: 0 } });
  const agent = await createAgentKernel({ id: "session", cwd: directory, engine, toolSafety: operations,
    outputContract: options.contract(directory), effects: { requestPermission: async () => ({ status: "approved" }) },
    preparation: { prepare: async scope => {
      const capabilityView = createRunCapabilityView({ toolRegistry: registry });
      const release = operations.onRunCapabilities({ scope, capabilityView, pluginCandidates: [], resolveToolAppOrigin: async () => undefined });
      return { run: { tools: capabilityView.tools, toolResults: results.forRun(scope, capabilityView.tools) }, release };
    } },
    onEvent: event => {
      events.push(structuredClone(event));
      if (event.type === "run.started") store.runs.updateRun(event.context.runId!, { status: "running" });
      if (event.type === "run.completed") store.runs.updateRun(event.context.runId!, { status: "completed", metadata: { delivery: event.data.delivery } });
      if (event.type === "run.failed") store.runs.updateRun(event.context.runId!, { status: "failed" });
      if (event.type === "run.interrupted") store.runs.updateRun(event.context.runId!, { status: "interrupted" });
    },
  });
  cleanup.push(() => agent.close());
  return { agent, directory, store, events, requests: () => requests };
}
function completed(events: AgentEvent[], id: string): ToolExecutionResult | undefined {
  const event = events.find(event => event.type === "tool.completed" && event.data.toolUseId === id);
  return event?.type === "tool.completed" ? event.data.result as ToolExecutionResult : undefined;
}

describe("structured delivery and S1 through real SQLite, Kernel and QueryEngine", () => {
  it("rejects invalid structure and missing business output before dispatch, then accepts a corrected receipt", async () => {
    const snapshots: ReturnType<typeof ledger>[] = [];
    const verified: boolean[] = [];
    const f = await fixture({
      contract: directory => ({ schema, verify: candidate => {
        const path = join(directory, (candidate.data as { path: string }).path);
        const ok = existsSync(path) && readFileSync(path, "utf8") === "verified report\n";
        verified.push(ok);
        return { ok, reason: "The report file is missing or incomplete" };
      } }),
      next(request, _messages, store) {
        if (request > 1) snapshots.push(ledger(store));
        if (request === 1) return { id: "invalid-schema", name: "SubmitResult", input: { ...delivery, data: {} } };
        if (request === 2) return { id: "missing-report", name: "SubmitResult", input: delivery };
        if (request === 3) return { id: "repair", name: "RepairReport", input: {} };
        if (request === 4) return { id: "valid-report", name: "SubmitResult", input: delivery };
      },
    });
    const result = await f.agent.runMessage("Create the report and submit its checked result", { ids });
    expect(snapshots[0]).toEqual([]);
    expect(snapshots[1]).toMatchObject([{ call: "missing-report", state: "rejected", result: { isError: true, executionState: "not_started", failureKind: "invalid_input" }, attempts: [] }]);
    expect(snapshots[1]![0]!.result?.toolAttemptId).toBeUndefined();
    expect(completed(f.events, "invalid-schema")).toMatchObject({ isError: true, executionState: "not_started", failureKind: "invalid_input" });
    expect(completed(f.events, "missing-report")).toMatchObject({ isError: true, executionState: "not_started", failureKind: "invalid_input" });
    expect(completed(f.events, "missing-report")?.toolAttemptId).toBeUndefined();
    expect(verified).toEqual([false, true]);
    expect(readFileSync(join(f.directory, "report.md"), "utf8")).toBe("verified report\n");
    const rows = ledger(f.store);
    expect(rows.map(row => [row.call, row.state, row.attempts.length])).toEqual([
      ["missing-report", "rejected", 0], ["repair", "confirmed", 1], ["valid-report", "confirmed", 1],
    ]);
    expect(rows.some(row => row.state === "unknown")).toBe(false);
    expect(result.delivery).toEqual({ ...delivery, validation: "schema_valid", verification: "passed" });
    expect(completed(f.events, "repair")?.resultRef).toMatchObject({ id: expect.any(String), toolName: "RepairReport", totalChars: 12 });
    const savedReceipt = rows[2]!.result!.content[0]!;
    expect(savedReceipt.type === "text" && JSON.parse(savedReceipt.text)).toEqual(result.delivery);
    expect(f.events.find(event => event.type === "run.completed")?.data).toHaveProperty("delivery", result.delivery);
    expect(f.store.runs.getRun("run")).toMatchObject({ status: "completed", metadata: { delivery: result.delivery } });
    expect(f.requests()).toBe(4);
  });

  it("cancels a pending host verifier and never dispatches when its late answer arrives", async () => {
    const entered = deferred<void>(), answer = deferred<{ ok: boolean }>(), returned = deferred<void>();
    const f = await fixture({
      contract: () => ({ schema, verify: async () => {
        entered.resolve();
        try { return await answer.promise; } finally { returned.resolve(); }
      } }),
      next: request => request === 1 ? { id: "pending-verification", name: "SubmitResult", input: delivery } : undefined,
    });
    const handle = f.agent.submitMessage("Submit after host verification", { ids });
    const outcome = handle.result.then(result => ({ result, error: undefined }), error => ({ result: undefined, error }));
    await Promise.race([entered.promise, handle.result.then(() => { throw new Error("Run completed before entering host verification"); })]);
    expect(ledger(f.store)).toMatchObject([{ call: "pending-verification", state: "authorized", attempts: [] }]);
    await handle.interrupt("Cancel pending host verification");
    expect((await outcome).error).toBeDefined();
    expect((await outcome).result).toBeUndefined();
    const cancelled = ledger(f.store);
    expect(cancelled).toMatchObject([{ call: "pending-verification", state: "cancelled", result: { isError: true, executionState: "not_started", failureKind: "interrupted" }, attempts: [] }]);
    answer.resolve({ ok: true });
    await returned.promise;
    await setImmediate();
    expect(ledger(f.store)).toEqual(cancelled);
    expect(f.store.runs.getRun("run")?.status).toBe("interrupted");
    expect(f.events.filter(event => event.type === "run.completed")).toEqual([]);
    expect(f.events.filter(event => event.type === "run.interrupted")).toHaveLength(1);
    expect(completed(f.events, "pending-verification")?.toolAttemptId).toBeUndefined();
    expect(f.requests()).toBe(1);
  });
});

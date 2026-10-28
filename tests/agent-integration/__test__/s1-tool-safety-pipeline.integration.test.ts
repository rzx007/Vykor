import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentExecutionContext, Message, StreamingMessageClient, ToolDefinition, ToolResult } from "@vykor/agent-contracts";
import { QueryEngine, ToolRegistry } from "@vykor/core";
import { SessionStore } from "@vykor/services";
import { createShellTool } from "@vykor/tools";
import { createShellProcess, resolveHostShellLauncher } from "@vykor/sandbox";
import { DefaultShellExecutor } from "../../../packages/tools/src/shell/executor.js";
import { ToolOperationService } from "../../../packages/server/src/application/session/execution/tool-operation-service.js";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const dispose of cleanup.splice(0).reverse()) dispose(); });

const success: ToolResult = { content: [{ type: "text", text: "external receipt" }], executionState: "completed" };

function fixture(options: { invoke?(): Promise<ToolResult>; timeoutMs?: number; failReceiptCommit?: boolean; client?: StreamingMessageClient; tools?: ToolDefinition[]; readOnlyTools?: ToolDefinition[] } = {}) {
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
  const tools = [tool, ...(options.tools ?? []), ...(options.readOnlyTools ?? [])];
  for (const definition of tools) registry.register(definition, { kind: "builtin" });
  const service = new ToolOperationService({ store, ownerLease: () => lease,
    describe: intent => options.readOnlyTools?.some(definition => definition.execute === intent.binding?.invoke)
      ? { kind: "read_only" } : undefined,
  });
  const scope = { agentId: "session", sessionId: "session", runId: "run", inputId: "input", cwd: directory,
    traceId: "trace", signal: new AbortController().signal };
  const execution: AgentExecutionContext = { scope, toolSafety: service,
    tools: new Map(tools.map(definition => [definition.name, { definition, source: { kind: "builtin" as const }, invoke: definition.execute }])),
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
  it("delivers real Shell timeout output to the model, allows inspection and keeps writes blocked after new evidence", async () => {
    let processStopped: Promise<void> | undefined;
    const executor = new DefaultShellExecutor({
      createProcess: async (command, options) => {
        const child = await createShellProcess(command, options);
        processStopped = new Promise(resolve => { child.once("close", () => resolve()); });
        return child;
      },
    });
    const nodeCommand = `${resolveHostShellLauncher().kind === "powershell" ? "& " : ""}${JSON.stringify(process.execPath.replaceAll("\\", "/"))}`;
    let observedOutput!: () => void;
    const outputReady = new Promise<void>(resolve => { observedOutput = resolve; });
    let shellOutput = "";
    const shell = createShellTool({
      resolve: (request, context) => executor.resolve(request, context),
      run: (spec, signal, onOutput) => executor.run(spec, signal, text => {
        onOutput?.(text);
        shellOutput += text;
        if (shellOutput.includes("partial-before-timeout")) observedOutput();
      }),
    });
    let inspected = 0;
    const inspect: ToolDefinition = { name: "Inspect", description: "trusted read-only diagnostic", inputSchema: { type: "object" },
      execute: async () => { inspected++; return { content: [{ type: "text", text: "observed external state" }] }; },
    };
    const histories: Message[][] = [];
    const f = fixture({
      tools: [shell],
      readOnlyTools: [inspect],
      client: { async *streamMessage({ messages }) {
        histories.push(structuredClone(messages));
        const turn = histories.length;
        if (turn === 4) {
          yield { type: "text_delta", delta: "Query timed out; inspected state, write remains unresolved." };
          yield { type: "complete", stopReason: "end_turn" };
          return;
        }
        const uses = turn === 2
          ? [{ type: "tool_use" as const, id: "blocked-write", name: "ExternalWrite", input: { text: "value" } },
             { type: "tool_use" as const, id: "inspect", name: "Inspect", input: {} }]
          : turn === 1
            ? [{ type: "tool_use" as const, id: "timeout", name: "Shell", input: { command: `${nodeCommand} -e "process.stdout.write('partial-before-timeout\\n'); setTimeout(() => {}, 10_000)"`, timeout: 100 } }]
            : [{ type: "tool_use" as const, id: "write-after-evidence", name: "ExternalWrite", input: { text: "value" } }];
        for (const toolUse of uses) yield { type: "tool_use_start", toolUse };
        yield { type: "complete", stopReason: "tool_use" };
      } },
    });
    const events = [];
    // Start the real process and observe its output before advancing only the timeout clock.
    // Host shell startup is not required to finish within the tested 100 ms budget.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const running = (async () => {
        for await (const event of f.engine.submitMessage("query and inspect", { execution: f.execution })) events.push(event);
      })();
      await Promise.race([outputReady, running.then(() => { throw new Error(`Shell ended before its output was observed: ${shellOutput}`); })]);
      await vi.advanceTimersByTimeAsync(2_100);
      await running;
    } finally {
      vi.useRealTimers();
      // A timeout result is not confirmation that the real process has stopped.
      await processStopped;
    }
    expect(histories).toHaveLength(4);
    const timeout = histories[1]!.find(message => message.type === "tool_result" && message.toolUseId === "timeout");
    expect(timeout).toMatchObject({ isError: true, failureKind: "timeout", executionState: "unknown" });
    expect(JSON.stringify(timeout)).toContain("partial-before-timeout");
    expect(JSON.stringify(timeout)).toContain("Command timed out");
    expect(inspected).toBe(1);
    expect(f.effects()).toBe(0);
    for (const id of ["blocked-write", "write-after-evidence"]) {
      expect(histories[3]!.find(message => message.type === "tool_result" && message.toolUseId === id))
        .toMatchObject({ isError: true, failureKind: "policy", executionState: "not_started" });
    }
    expect(f.store.toolOperations.list().filter(operation => operation.state === "unknown")).toHaveLength(1);
    expect(events.filter(event => event.type === "tool_use_end")).toHaveLength(4);
    expect(events).toContainEqual({ type: "text_delta", delta: "Query timed out; inspected state, write remains unresolved." });
  });

  it("resumes writes only after a real late receipt and never redelivers the timed-out call", async () => {
    let release!: (result: ToolResult) => void;
    const pending = new Promise<ToolResult>(resolve => { release = resolve; });
    const inspect: ToolDefinition = { name: "Inspect", description: "read-only wait for external receipt", inputSchema: { type: "object" },
      execute: async () => {
        release(structuredClone(success));
        await vi.waitFor(() => expect(f.store.toolOperations.list()[0]!.state).toBe("confirmed"));
        return { content: [{ type: "text", text: "external operation is now confirmed" }] };
      },
    };
    let turns = 0;
    const f = fixture({ timeoutMs: 200, readOnlyTools: [inspect],
      invoke: async () => f.effects() === 1 ? pending : structuredClone(success),
      client: { async *streamMessage() {
        turns++;
        if (turns <= 3) {
          yield { type: "tool_use_start", toolUse: { type: "tool_use", id: `call-${turns}`, name: turns === 2 ? "Inspect" : "ExternalWrite", input: turns === 2 ? {} : { text: "value" } } };
          yield { type: "complete", stopReason: "tool_use" };
        } else yield { type: "complete", stopReason: "end_turn" };
      } },
    });
    const delivered = [];
    for await (const event of f.engine.submitMessage("wait for receipt then continue", { execution: f.execution })) {
      if (event.type === "tool_use_end") delivered.push(event.result);
    }
    expect(turns).toBe(4);
    expect(f.effects()).toBe(2);
    expect(delivered).toHaveLength(3);
    expect(delivered.filter(result => result.toolUseId === "call-1"))
      .toEqual([expect.objectContaining({ executionState: "unknown", failureKind: "timeout" })]);
    expect(f.store.toolOperations.list().map(operation => operation.state)).toEqual(["confirmed", "confirmed", "confirmed"]);
    expect(f.store.toolOperations.listAttempts(f.store.toolOperations.list()[0]!.id)).toHaveLength(1);
  });

  it("continues an independent write after a trusted read-only timeout", async () => {
    const inspect: ToolDefinition = { name: "Inspect", description: "read-only timeout", inputSchema: { type: "object" },
      execute: async () => ({ content: [{ type: "text", text: "partial query output" }], isError: true, failureKind: "timeout", executionState: "unknown" }),
    };
    let turns = 0;
    const f = fixture({ readOnlyTools: [inspect], client: { async *streamMessage() {
      turns++;
      if (turns <= 2) {
        yield { type: "tool_use_start", toolUse: { type: "tool_use", id: `call-${turns}`, name: turns === 1 ? "Inspect" : "ExternalWrite", input: turns === 1 ? {} : { text: "independent" } } };
        yield { type: "complete", stopReason: "tool_use" };
      } else yield { type: "complete", stopReason: "end_turn" };
    } } });
    for await (const _event of f.engine.submitMessage("query then write", { execution: f.execution })) { /* drain */ }
    expect(turns).toBe(3);
    expect(f.effects()).toBe(1);
    expect(f.store.toolOperations.list().map(operation => operation.state)).toEqual(["unknown", "confirmed"]);
  });

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
    const timeout = await f.execute();
    expect(timeout).toMatchObject({ isError: true, failureKind: "timeout", executionState: "unknown" });
    const replay = await f.execute();
    expect(replay).toMatchObject({ isError: true, failureKind: "policy", executionState: "unknown" });
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

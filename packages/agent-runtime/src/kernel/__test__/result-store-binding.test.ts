import { describe, expect, it } from "vitest";
import type { AgentRunScope, RunToolBinding, ToolDefinition, ToolResultRef } from "@vykor/agent-contracts";
import { MemoryToolResultArchive } from "@vykor/core";
import { createAgentKernel, createBasicAgentKernelRuntime } from "../index.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe("Kernel final result-store binding", () => {
  it("does not bypass failed preparation when manual callers supply both a host check and a result store", async () => {
    const scope: AgentRunScope = { agentId: "manual", sessionId: "manual", runId: "r", inputId: "i", traceId: "t", cwd: "/workspace", signal: new AbortController().signal };
    const unavailable = async (): Promise<never> => { throw new Error("Tool execution must wait for preparation"); };
    const agent = await createAgentKernel({ id: "manual", cwd: "/workspace",
      effects: { requestPermission: async () => ({ status: "approved" }) },
      engine: createBasicAgentKernelRuntime({ cwd: "/workspace", client: { async *streamMessage() { throw new Error("No model request expected"); } } }),
      bindToolDispatch: () => unavailable,
      preparation: { async prepare() { throw new Error("Preparation is unavailable"); } },
    });
    try {
      await expect(agent.runTool({ type: "tool_use", id: "call", name: "Read", input: {} }, {
        scope, tools: new Map(), toolResults: new MemoryToolResultArchive().forRun(scope, new Map()),
      })).rejects.toThrow("Preparation is unavailable");
    } finally { await agent.close(); }
  });
  it("waits for reliable Run start projection before binding and for binding before acknowledging or requesting a model", async () => {
    const archive = new MemoryToolResultArchive();
    const projecting = deferred(), releaseProjection = deferred(), binding = deferred(), releaseBinding = deferred();
    let projected = false, bound = false, acknowledged = false, modelRequests = 0;
    const agent = await createAgentKernel({ id: "projected-results", cwd: "/workspace",
      effects: { requestPermission: async () => ({ status: "approved" }) },
      engine: createBasicAgentKernelRuntime({ cwd: "/workspace", client: { async *streamMessage() {
        modelRequests++;
        yield { type: "text_delta", delta: "done" };
        yield { type: "complete", stopReason: "end_turn" };
      } } }),
      onEvent: async event => {
        if (event.type !== "run.started") return;
        projecting.resolve();
        await releaseProjection.promise;
        projected = true;
      },
      preparation: { async prepare(scope) { return { run: { tools: new Map(), bindToolResults: async tools => {
        if (!projected) throw new Error("The durable Run has not been projected");
        binding.resolve();
        await releaseBinding.promise;
        bound = true;
        return archive.forRun(scope, tools);
      } }, release() { archive.releaseRun(scope.runId); } }; } },
    });
    const run = agent.submitMessage("hello");
    void run.started.then(() => { acknowledged = true; }, () => { acknowledged = true; });
    try {
      await Promise.race([projecting.promise, run.result]);
      expect(projected).toBe(false);
      expect(bound).toBe(false);
      expect(acknowledged).toBe(false);
      expect(modelRequests).toBe(0);

      releaseProjection.resolve();
      await Promise.race([binding.promise, run.result]);
      expect(projected).toBe(true);
      expect(bound).toBe(false);
      expect(acknowledged).toBe(false);
      expect(modelRequests).toBe(0);

      releaseBinding.resolve();
      await run.started;
      expect(bound).toBe(true);
      await expect(run.result).resolves.toMatchObject({ output: "done" });
      expect(modelRequests).toBe(1);
    } finally {
      releaseProjection.resolve();
      releaseBinding.resolve();
      await agent.close();
    }
  });

  it.each([false, true])("binds an async provider after filtering and keeps it outside tool capabilities (manual=%s)", async manual => {
    const archive = new MemoryToolResultArchive();
    let bound: ReadonlyMap<string, RunToolBinding> | undefined, turn = 0;
    const probe: ToolDefinition = { name: "Probe", description: "inspect execution capabilities", inputSchema: {}, execute: async (_input, context) => ({
      content: [{ type: "text", text: JSON.stringify({ providerVisible: "bindToolResults" in context.agent! }) }], executionState: "completed",
    }) };
    const hidden: ToolDefinition = { name: "Hidden", description: "excluded source", inputSchema: {}, execute: async () => ({ content: [] }) };
    const bindings = new Map<string, RunToolBinding>([probe, hidden].map(definition => [definition.name,
      { definition, definitionIdentity: Symbol(definition.name), invoke: definition.execute, source: { kind: "builtin" } }]));
    const agent = await createAgentKernel({ id: "bound-results", cwd: "/workspace",
      effects: { requestPermission: async () => ({ status: "approved" }) },
      engine: createBasicAgentKernelRuntime({ cwd: "/workspace", tools: [probe, hidden], client: { async *streamMessage(params) {
        if (turn++ === 0) yield { type: "tool_use_start", toolUse: { type: "tool_use", id: "probe", name: "Probe", input: {} } };
        else yield { type: "text_delta", delta: params.messages.find(message => message.type === "tool_result")!.content.filter(block => block.type === "text").map(block => block.text).join("\n") };
        yield { type: "complete", stopReason: turn === 1 ? "tool_use" : "end_turn" };
      } } }),
      preparation: { async prepare(scope) { return { run: { tools: bindings, bindToolResults: async finalTools => {
        await Promise.resolve(); bound = finalTools; return archive.forRun(scope, finalTools);
      } }, release() { archive.releaseRun(scope.runId); } }; } } });
    try {
      const tools = new Map([["Probe", bindings.get("Probe")!]]);
      const scope: AgentRunScope = { runId: "manual", agentId: agent.id, sessionId: agent.id, cwd: "/workspace", inputId: "i", traceId: "t", signal: new AbortController().signal };
      const output = manual ? (await agent.runTool({ type: "tool_use", id: "probe", name: "Probe", input: {} }, { tools, scope })).content.filter(block => block.type === "text").map(block => block.text).join("")
        : (await agent.runMessage("inspect", { tools })).output;
      expect(output).toContain('"providerVisible":false');
      expect([...bound!.keys()]).toEqual(["Probe"]);
      expect(bound!.get("Probe")?.source).toEqual({ kind: "builtin" });
    } finally { await agent.close(); }
  });

  it.each([false, true])("closes a prebound store when model tools narrow, preserving equivalent complete bindings (manual=%s)", async manual => {
    const archive = new MemoryToolResultArchive();
    let ref: ToolResultRef | undefined, turn = 0;
    const source: ToolDefinition = { name: "Source", description: "private source", inputSchema: {}, execute: async () => ({ content: [] }) };
    const reader: ToolDefinition = { name: "Reader", description: "read result", inputSchema: {}, execute: async (_input, context) => {
      const text = context.toolResults ? (await context.toolResults.read({ id: ref!.id })).text : "archive unavailable";
      return { content: [{ type: "text", text }], executionState: "completed" };
    } };
    const bindings = new Map<string, RunToolBinding>([source, reader].map(definition => [definition.name,
      { definition, definitionIdentity: Symbol(definition.name), invoke: definition.execute, source: { kind: "builtin" } }]));
    const engine = createBasicAgentKernelRuntime({ cwd: "/workspace", tools: [source, reader],
      client: { async *streamMessage(params) {
        if (turn++ % 2 === 0) yield { type: "tool_use_start", toolUse: { type: "tool_use", id: "read", name: "Reader", input: {} } };
        else yield { type: "text_delta", delta: params.messages.filter(message => message.type === "tool_result").at(-1)!.content.filter(block => block.type === "text").map(block => block.text).join("\n") };
        yield { type: "complete", stopReason: turn % 2 ? "tool_use" : "end_turn" };
      } } });
    const agent = await createAgentKernel({ id: "kernel-results", cwd: "/workspace", engine,
      effects: { requestPermission: async () => ({ status: "approved" }) },
      preparation: { async prepare(scope) {
        const toolResults = archive.forRun(scope, bindings);
        ref = await toolResults.retain({ toolUseId: "source", toolName: "Source", content: [{ type: "text", text: "SECRET" }], executionState: "completed" });
        return { run: { tools: bindings, toolResults }, release() { archive.releaseRun(scope.runId); } };
      } } });
    try {
      const restricted = new Map([["Reader", bindings.get("Reader")!]]);
      const run = async (tools: ReadonlyMap<string, RunToolBinding>, runId: string) => {
        if (!manual) return (await agent.runMessage("read result", { tools })).output;
        const scope: AgentRunScope = { runId, agentId: agent.id, sessionId: agent.id, cwd: "/workspace", inputId: runId, traceId: runId, signal: new AbortController().signal };
        return JSON.stringify((await agent.runTool({ type: "tool_use", id: "read", name: "Reader", input: {} }, { tools, scope })).content);
      };
      expect(await run(restricted, "restricted")).not.toContain("SECRET");
      expect(await run(bindings, "full")).toContain("SECRET");
      if (manual) {
        const replaced = new Map(bindings);
        replaced.set("Source", { ...bindings.get("Source")!, source: { kind: "plugin", id: "replacement" } });
        expect(await run(replaced, "source-replaced")).not.toContain("SECRET");
      }
    } finally { await agent.close(); }
  });
});

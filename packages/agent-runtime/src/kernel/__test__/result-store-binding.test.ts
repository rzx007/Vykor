import { describe, expect, it } from "vitest";
import type { AgentRunScope, RunToolBinding, ToolDefinition, ToolResultRef } from "@vykor/agent-contracts";
import { MemoryToolResultArchive } from "@vykor/core";
import { createAgentKernel, createBasicAgentKernelRuntime } from "../index.js";

describe("Kernel final result-store binding", () => {
  it("binds an async provider after filtering and keeps the provider outside tool execution capabilities", async () => {
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
      const result = await agent.runMessage("inspect", { tools: new Map([["Probe", bindings.get("Probe")!]]) });
      expect(result.output).toContain('"providerVisible":false');
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

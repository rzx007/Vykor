import { describe, expect, it } from "vitest";
import { QueryEngine } from "./query-engine.js";
import { ToolRegistry } from "./tool-registry.js";
import type { AgentExecutionContext, RunCapabilityView, ToolDefinition } from "../types/index.js";

describe("multi-plugin result references", () => {
  it("shares a captured result across allowed plugins and rejects absent or replaced source bindings", async () => {
    const registry = new ToolRegistry();
    const fetch: ToolDefinition = { name: "Fetch", description: "fetch", inputSchema: { type: "object" },
      execute: async () => ({ content: [{ type: "text", text: "actual fetched data" }] }) };
    const read: ToolDefinition = { name: "Read", description: "read", inputSchema: { type: "object" },
      execute: async (_input, context) => ({ content: [{ type: "text", text: JSON.stringify(context.readToolResult?.("fetched")?.content ?? "unavailable") }] }) };
    registry.register(fetch, { kind: "plugin", id: "fetcher" });
    registry.register(read, { kind: "plugin", id: "writer" });
    const fetchBinding = { ownerPluginId: "fetcher", source: { kind: "plugin" as const, id: "fetcher" }, definition: fetch, invoke: fetch.execute };
    const readBinding = { ownerPluginId: "writer", source: { kind: "plugin" as const, id: "writer" }, definition: read, invoke: read.execute };
    const view: RunCapabilityView = { pluginIds: new Set(["fetcher", "writer"]), tools: new Map([["Fetch", fetchBinding], ["Read", readBinding]]), skills: new Map(), agents: new Map(), mcpServers: new Map() };
    const engine = new QueryEngine({ async *streamMessage() { throw new Error("no model"); } }, registry,
      { checkTool: async () => ({ action: "allow" }) } as any, { execute: async () => ({ blocked: false }) } as any);
    const execution = (capabilityView: RunCapabilityView, runId = "run") => ({ scope: { runId, signal: new AbortController().signal }, capabilityView, emit: async () => {} }) as AgentExecutionContext;
    await engine.executeTool({ type: "tool_use", id: "fetched", name: "Fetch", input: {} }, { execution: execution(view) });
    const invokeRead = (scope: RunCapabilityView, runId?: string) => engine.executeTool({ type: "tool_use", id: "read", name: "Read", input: {} }, { execution: execution(scope, runId) });
    expect(JSON.stringify((await invokeRead(view)).content)).toContain("actual fetched data");
    const replaced = { ...fetchBinding, ownerPluginId: "writer" };
    for (const tools of [new Map([["Read", readBinding]]), new Map([["Fetch", replaced], ["Read", readBinding]])]) {
      expect(JSON.stringify((await invokeRead({ ...view, tools })).content)).toContain("unavailable");
    }
    expect(JSON.stringify((await invokeRead(view, "later-run")).content)).toContain("unavailable");
  });
});

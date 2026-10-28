import { describe, expect, it } from "vitest";
import type { ToolDefinition, ToolResult, ToolUseBlock } from "@vykor/agent-contracts";
import { QueryEngine, ToolRegistry } from "@vykor/core";
import { createMcpTools } from "@vykor/tools";

const targetName = "mcp__server__edit";
function call(id: string, name: string, input: Record<string, unknown> = {}): ToolUseBlock {
  return { type: "tool_use", id, name, input };
}
const proxy = (id: string, toolName = "edit") => call(id, "McpToolCall", { serverName: "server", toolName, args: {} });

async function run(options: { deny?: boolean; source?: "builtin" | "plugin"; unknown?: boolean } = {}) {
  let invocations = 0;
  const checked: string[] = [];
  const requests: string[][] = [];
  const registry = new ToolRegistry();
  registry.register({ name: targetName, description: "controlled MCP target", inputSchema: { type: "object" },
    execute: async () => { invocations++; return { content: [{ type: "text", text: "edited" }] }; },
  }, options.source === "plugin" ? { kind: "plugin", id: "foreign" }
    : options.source === "builtin" ? { kind: "builtin" } : { kind: "mcp", id: "server" });
  registry.register(createMcpTools().find(tool => tool.name === "McpToolCall")!, { kind: "builtin" });
  const search: ToolDefinition = { name: "Search", description: "expose the eligible MCP target", inputSchema: { type: "object" },
    execute: async (_input, context) => ({ content: [{ type: "text", text: JSON.stringify(context.toolDiscovery!.expose([targetName])) }] }),
  };
  registry.register(search, { kind: "builtin" });
  const batches = options.source ? [[proxy("first")]] : options.unknown
    ? [[proxy("first", "absent")], [proxy("second", "absent")]]
    : [[call("search", "Search"), proxy("first")], [proxy("second")]];
  const engine = new QueryEngine({ async *streamMessage(params) {
    const batch = batches[requests.length];
    requests.push(params.tools?.map(tool => tool.name) ?? []);
    for (const toolUse of batch ?? []) yield { type: "tool_use_start" as const, toolUse };
    yield { type: "complete" as const, stopReason: batch ? "tool_use" : "end_turn" };
  } }, registry, { checkTool: async name => {
    checked.push(name);
    return { action: options.deny && name === targetName ? "deny" : "allow" };
  } }, { register() {}, execute: async () => ({ blocked: false }) }, {
    trajectoryTrackerFactory: false,
    ...(options.source ? {} : { toolDiscovery: { searchTool: search, minToolCount: 1, minSchemaBytes: 1,
      shouldDefer: (_tool, source) => source?.kind === "mcp" } }),
  });
  const results: Array<ToolResult & { toolUseId: string }> = [];
  for await (const event of engine.submitMessage("inspect then continue"))
    if (event.type === "tool_use_end") results.push(event.result);
  return { invocations, checked, requests, results };
}

describe("real MCP proxy discovery continuation", () => {
  it.each([false, true])("checks the newly loaded target after same-batch search (deny=%s)", async deny => {
    const f = await run({ deny });
    expect(f.requests[0]).not.toContain(targetName);
    expect(f.requests[1]).toContain(targetName);
    expect(f.results.find(result => result.toolUseId === "first")).toMatchObject({ isError: true, executionState: "unknown", failureKind: "policy" });
    const second = f.results.find(result => result.toolUseId === "second")!;
    if (deny) expect(second).toMatchObject({ isError: true, executionState: "unknown", failureKind: "permission" });
    else expect(second).toMatchObject({ executionState: "completed", content: [{ type: "text", text: "edited" }] });
    expect(f.invocations).toBe(deny ? 0 : 1);
    expect(f.checked.filter(name => name === targetName)).toHaveLength(1);
    expect(f.checked.filter(name => name === "McpToolCall")).toHaveLength(2);
  });

  it.each(["builtin", "plugin"] as const)("refuses an exposed %s tool with an MCP-looking name", async source => {
    const f = await run({ source });
    expect(f.requests[0]).toContain(targetName);
    expect(f.results[0]).toMatchObject({ isError: true, executionState: "unknown", failureKind: "policy" });
    expect(f.invocations).toBe(0);
    expect(f.checked).not.toContain(targetName);
  });

  it("keeps unknown targets under the ordinary failed-call handling", async () => {
    const f = await run({ unknown: true });
    expect(f.results[0]).toMatchObject({ isError: true, executionState: "unknown" });
    expect(f.results[1]).toMatchObject({ executionState: "not_started", metadata: { recoveryGuard: "repeated_failed_call" } });
    expect(f.invocations).toBe(0);
    expect(f.checked.filter(name => name === "McpToolCall")).toHaveLength(1);
  });
});

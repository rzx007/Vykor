import { describe, expect, it } from "vitest";
import { QueryEngine } from "./query-engine.js";
import { ToolRegistry } from "./tool-registry.js";
import { ModelRequestFailure } from "./model-retry.js";
import { createRunCapabilityView } from "../../../agent-runtime/src/run-capability-view.js";
import type { AgentExecutionContext, QueryEngineOptions, StreamEvent, StreamMessageParams, ToolDefinition, ToolUseEndEvent } from "../index.js";

let callId = 0;
const call = (name: string, input: Record<string, unknown> = {}): StreamEvent => ({
  type: "tool_use_start", toolUse: { type: "tool_use", id: `discovery-${++callId}`, name, input },
});

function fixture(options: {
  batches?: StreamEvent[][];
  policy?: boolean;
  search?: "missing" | "replaced";
  denied?: boolean;
  minToolCount?: number;
  largeSchema?: boolean;
  retryAt?: number;
  engineOptions?: Partial<QueryEngineOptions>;
} = {}) {
  const invoked: string[] = [], checked: string[] = [], requests: StreamMessageParams[] = [], compactRequests: StreamMessageParams[] = [];
  const registry = new ToolRegistry();
  const define = (name: string): ToolDefinition => ({ name, description: `${name} operation`,
    inputSchema: { type: "object", properties: { value: { type: "string" } },
      ...(options.largeSchema && name === "Deferred" ? { description: "large-schema-only ".repeat(2000) } : {}),
    },
    async execute() { invoked.push(name); return { content: [{ type: "text", text: name }] }; },
  });
  const search: ToolDefinition = { ...define("Search"), async execute(input, context) {
    const discovery = context.toolDiscovery;
    if (!discovery) return { content: [], isError: true };
    const eligible = discovery.getEligibleNames();
    const names = discovery.catalog.filter(row => eligible.has(row.name) && row.name.includes(String(input.query))).map(row => row.name);
    return { content: [{ type: "text", text: JSON.stringify(discovery.expose(names)) }] };
  } };
  registry.register(define("Read"), { kind: "builtin" });
  registry.register(define("Deferred"), { kind: "plugin", id: "office" });
  registry.register(define("mcp__server__edit"), { kind: "mcp", id: "server" });
  registry.register({ ...define("McpToolCall"), async execute(input, context) {
    return context.callMcpTool!("mcp__server__edit", input);
  } }, { kind: "builtin" });
  if (options.search !== "missing") registry.register(options.search === "replaced" ? { ...search, execute: define("Other").execute } : search, { kind: "builtin" });
  let logicalRequest = 0;
  const engine = new QueryEngine({ async *streamMessage(params) {
    if (params.system === "You are a conversation summarizer.") {
      compactRequests.push(params);
      yield { type: "text_delta", delta: "Scripted history summary" } as const;
      yield { type: "complete", stopReason: "end_turn" } as const;
      return;
    }
    requests.push({ ...params, messages: structuredClone(params.messages) });
    if (options.retryAt === requests.length) throw new ModelRequestFailure("scripted retry", { kind: "network", phase: "request", retryable: true });
    const batch = options.batches?.[logicalRequest++];
    yield* batch ?? [];
    yield { type: "complete", stopReason: batch?.length ? "tool_use" : "end_turn" } as const;
  } }, registry, { async checkTool(name) { checked.push(name); return { action: options.denied && name === "Deferred" ? "deny" : "allow" }; } },
  { register() {}, async execute() { return { blocked: false }; } }, {
    trajectoryTrackerFactory: false,
    ...(options.policy === false ? {} : { toolDiscovery: {
      searchTool: search, minToolCount: options.minToolCount ?? 1, minSchemaBytes: 32_768,
      shouldDefer: (_tool, source) => source?.kind === "plugin" || source?.kind === "mcp",
    } }),
    ...options.engineOptions,
  });
  async function run(execution?: AgentExecutionContext) {
    const results: ToolUseEndEvent["result"][] = [];
    for await (const event of engine.submitMessage("work", { execution })) if (event.type === "tool_use_end") results.push(event.result);
    return results;
  }
  return { engine, registry, invoked, checked, requests, compactRequests, run };
}

describe("Run-local tool discovery", () => {
  it("defers a small catalog with large schemas", async () => {
    const f = fixture({ minToolCount: 20, largeSchema: true }); await f.run();
    expect(JSON.stringify(f.requests[0]!.tools)).not.toContain("large-schema-only");
    expect(f.requests[0]!.tools?.map(t => t.name)).toContain("Search");
  });

  it("keeps exactly the same tool definitions across a physical model retry", async () => {
    const f = fixture({ batches: [[call("Search", { query: "Deferred" })], [call("Deferred")]], retryAt: 2,
      engineOptions: { modelRetry: { baseDelayMs: 1, maxDelayMs: 1 } },
    });
    await f.run();
    expect(f.requests).toHaveLength(4);
    expect(f.requests[1]!.tools).toBe(f.requests[2]!.tools);
    expect(f.requests[1]!.tools?.map(t => t.name)).toContain("Deferred");
    expect(f.invoked).toEqual(["Deferred"]);
  });

  it("retains exposed definitions when a steer is merged into the current Run", async () => {
    const f = fixture({ batches: [[call("Search", { query: "Deferred" })], [call("Deferred")]] });
    let delivered = false;
    await f.run({ scope: { signal: new AbortController().signal }, emit: async () => {}, effects: {}, closeSteering() {},
      takeSteeredInputs: async () => delivered ? [] : (delivered = true, [{ content: "merged-follow-up" }]),
    } as unknown as AgentExecutionContext);
    expect(f.requests[1]!.tools?.map(t => t.name)).toContain("Deferred");
    expect(JSON.stringify(f.requests[1]!.messages)).toContain("merged-follow-up");
    expect(f.invoked).toEqual(["Deferred"]);
  });

  it("retains loaded schemas through real context compaction", async () => {
    const f = fixture({ batches: [[call("Search", { query: "Deferred" })], [call("Deferred")]], engineOptions: {
      maxTokens: 1, compactKeepRecent: 1,
    } });
    await f.run();
    expect(f.compactRequests.length).toBeGreaterThan(0);
    expect(f.compactRequests.every(request => !request.tools?.length)).toBe(true);
    expect(f.requests[1]!.tools?.map(t => t.name)).toContain("Deferred");
    expect(f.invoked).toEqual(["Deferred"]);
  });

  it("keeps finalization tool-free even after successful discovery", async () => {
    const f = fixture({ batches: [[call("Search", { query: "Deferred" })]], engineOptions: {
      trajectoryTrackerFactory: () => ({ observe(_event, control) { control.forceFinal = true; } }),
    } }); await f.run();
    expect(f.requests[1]!.tools ?? []).toEqual([]);
    expect(f.invoked).toEqual([]);
  });

  it("defers schemas until search and preserves original execution and source", async () => {
    const f = fixture({ batches: [[call("Search", { query: "Deferred" })], [call("Deferred", { value: "x" })]] });
    const results = await f.run();
    expect(f.requests[0]!.tools?.map(t => t.name)).toEqual(["Read", "McpToolCall", "Search"]);
    expect(f.requests[1]!.tools?.find(t => t.name === "Deferred")?.inputSchema).toEqual({ type: "object", properties: { value: { type: "string" } } });
    expect(f.requests[1]!.tools?.map(t => t.name)).not.toContain("mcp__server__edit");
    expect(f.invoked).toEqual(["Deferred"]);
    expect(f.checked).toEqual(["Search", "Deferred"]);
    expect(results.every(r => !r.isError)).toBe(true);
    expect(f.registry.inspect("Deferred")?.source).toEqual({ kind: "plugin", id: "office" });
  });

  it("rejects a guessed target in the search batch, but permits identical input next request", async () => {
    const f = fixture({ batches: [[call("Search", { query: "Deferred" }), call("Deferred")], [call("Deferred")]] });
    const results = await f.run();
    expect(results[1]).toMatchObject({ isError: true, executionState: "not_started" });
    expect(JSON.stringify(results[1])).toContain("Search");
    expect(results[2]!.isError).not.toBe(true);
    expect(f.invoked).toEqual(["Deferred"]);
    expect(f.checked).toEqual(["Search", "Deferred"]);
  });

  it("blocks MCP proxy bypass until the target is exposed", async () => {
    const f = fixture({ batches: [[call("McpToolCall")], [call("Search", { query: "mcp__" })], [call("McpToolCall")]] });
    const results = await f.run();
    expect(results[0]).toMatchObject({ isError: true, executionState: "not_started" });
    expect(results[2]!.isError).not.toBe(true);
    expect(f.invoked).toEqual(["mcp__server__edit"]);
    expect(f.checked.filter(name => name === "mcp__server__edit")).toHaveLength(1);
  });

  it("does not retain an MCP proxy failure after same-batch search changes target availability", async () => {
    const f = fixture({ batches: [[call("Search", { query: "mcp__" }), call("McpToolCall")], [call("McpToolCall")]] });
    const results = await f.run();
    expect(results[1]).toMatchObject({ isError: true, executionState: "not_started" });
    expect(results[2]!.isError).not.toBe(true);
    expect(f.invoked).toEqual(["mcp__server__edit"]);
  });

  it.each(["missing", "replaced"] as const)("keeps normal exposure when trusted search is %s", async search => {
    const f = fixture({ search }); await f.run();
    expect(f.requests[0]!.tools?.map(t => t.name)).toContain("Deferred");
  });

  it("keeps the SDK default and a small catalog unchanged", async () => {
    const plain = fixture({ policy: false }); await plain.run();
    expect(plain.requests[0]!.tools?.map(t => t.name)).toContain("Deferred");
    const small = fixture({ minToolCount: 20 }); await small.run();
    expect(small.requests[0]!.tools?.map(t => t.name)).toContain("Deferred");
  });

  it("does not let searches escape the allowlist", async () => {
    const f = fixture({ batches: [[call("Search", { query: "mcp" })], [call("mcp__server__edit")]] });
    f.engine.setAllowedTools(["Read", "Search", "Deferred"]);
    const results = await f.run();
    expect(JSON.stringify(results[0])).not.toContain("mcp__server__edit");
    expect(f.requests.flatMap(r => r.tools?.map(t => t.name) ?? [])).not.toContain("mcp__server__edit");
    expect(f.invoked).toEqual([]);
  });

  it("keeps normal permission checks after discovery", async () => {
    const f = fixture({ denied: true, batches: [[call("Search", { query: "Deferred" })], [call("Deferred")]] });
    const results = await f.run();
    expect(results[1]).toMatchObject({ isError: true, executionState: "not_started", failureKind: "permission" });
    expect(f.invoked).toEqual([]);
    expect(f.checked).toEqual(["Search", "Deferred"]);
  });

  it("lets a trusted host action use its captured binding without model discovery", async () => {
    const f = fixture();
    const view = createRunCapabilityView({ toolRegistry: f.registry, pluginIds: new Set(["office"]) }, "office");
    const execution = { capabilityView: view, scope: { runId: "host-action", signal: new AbortController().signal },
      emit: async () => {}, effects: {}, closeSteering() {}, takeSteeredInputs: async () => [],
    } as unknown as AgentExecutionContext;
    await f.run(execution);
    expect(f.requests[0]!.tools?.map(t => t.name)).not.toContain("Deferred");
    const result = await f.engine.executeTool({ type: "tool_use", id: "host-click", name: "Deferred", input: {} }, { execution });
    expect(result.isError).not.toBe(true);
    expect(f.invoked).toEqual(["Deferred"]);
    expect(f.checked).toEqual(["Deferred"]);
  });

  it("drops only discovery state for the next Run, retaining settled history", async () => {
    const f = fixture({ batches: [[call("Search", { query: "Deferred" })], [call("Deferred")]] });
    await f.run(); const firstRunRequests = f.requests.length; await f.run();
    expect(f.requests[firstRunRequests]!.tools?.map(t => t.name)).not.toContain("Deferred");
    expect(f.requests[firstRunRequests]!.messages.some(m => m.type === "tool_result")).toBe(true);
    expect(f.invoked).toEqual(["Deferred"]);
  });

  it("honors trajectory hiding even after a tool was discovered", async () => {
    const f = fixture({ batches: [[call("Search", { query: "Deferred" })], [call("Deferred")]], engineOptions: {
      trajectoryTrackerFactory: () => ({ observe(_event, control) { control.hiddenTools = ["Deferred"]; } }),
    } });
    const results = await f.run();
    expect(f.requests[1]!.tools?.map(t => t.name)).not.toContain("Deferred");
    expect(results[1]).toMatchObject({ isError: true, executionState: "not_started" });
    expect(f.invoked).toEqual([]);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpTools } from "@vykor/tools";
const mcpToolCallTool = createMcpTools().find(tool => tool.name === "McpToolCall")!;
import type { AgentEventInput, AgentExecutionContext, PermissionChecker as IPermissionChecker, StreamEvent, ToolDefinition } from "@vykor/agent-contracts";
import type { Message } from "@vykor/agent-contracts";
import { QueryEngine } from "@vykor/core/engine";
import { ToolRegistry } from "@vykor/core/engine";
import { runToolRegistry, toolRegistryView } from "@vykor/core/engine";
import { RunToolDiscovery } from "@vykor/core/engine";

afterEach(() => vi.useRealTimers());

function fixture(options: { captured?: boolean; source?: "mcp" | "agent"; decision?: "allow" | "deny" | "ask"; approved?: boolean; blocked?: boolean; invoke?: ToolDefinition["execute"]; timeoutMs?: number; modelLoop?: boolean } = {}) {
  const events: AgentEventInput[] = [];
  const checked: string[] = [];
  const hooks: string[] = [];
  let calls = 0;
  const controller = new AbortController();
  const modelMessages: Message[][] = [];
  const target: ToolDefinition = { name: "mcp__remote__query", description: "MCP query", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }, execute: async (input, context) => {
    calls++;
    return options.invoke?.(input, context) ?? { content: [{ type: "text", text: `captured ${input.text}` }] };
  } };
  const registry = new ToolRegistry();
  registry.register(mcpToolCallTool, { kind: "builtin" });
  registry.register({ ...target, execute: async () => { throw new Error("global target must not execute"); } }, { kind: options.source ?? "mcp", id: "remote" });
  const execution: AgentExecutionContext = {
    scope: { agentId: "a", sessionId: "s", runId: "r", inputId: "i", cwd: "/runtime", traceId: "t", signal: controller.signal },
    tools: new Map([
      ["McpToolCall", { definition: mcpToolCallTool, source: { kind: "builtin" }, invoke: mcpToolCallTool.execute }],
      ...(options.captured === false ? [] : [[target.name, { definition: target, source: { kind: options.source ?? "mcp", id: "remote" }, invoke: target.execute }] as const]),
    ]),
    effects: { requestPermission: async request => {
      expect(request.toolName).toBe(target.name);
      expect(calls).toBe(0);
      return { status: options.approved === false ? "denied" : "approved" };
    } },
    children: { hasChildAgent: () => false, spawnChildAgent: async () => { throw new Error("unexpected child"); }, sendChildInput: async () => { throw new Error("unexpected child"); }, interruptChildAgent: async () => {}, awaitChildAgent: async () => { throw new Error("unexpected child"); } },
    emit: async event => { events.push(event); }, takeSteeredInputs: async () => [], closeSteering() {},
  };
  const permission: IPermissionChecker = { checkTool: async name => { checked.push(name); return { action: name === target.name ? options.decision ?? "allow" : "allow" }; } };
  const engine = new QueryEngine({ streamMessage: async function* (params): AsyncIterable<StreamEvent> {
    if (!options.modelLoop) throw new Error("no model call expected");
    modelMessages.push(structuredClone(params.messages));
    if (modelMessages.length === 1) {
      yield { type: "tool_use_start", toolUse: { type: "tool_use", id: "proxy-call", name: "McpToolCall", input: { serverName: "remote", toolName: "query", args: { text: "hello" } } } };
      yield { type: "complete", stopReason: "tool_use" };
    } else yield { type: "complete", stopReason: "end_turn" };
  } }, registry, permission, {
    register() {}, execute: async (event, data) => { hooks.push(`${event}:${data.tool}`); return { blocked: options.blocked === true && data.tool === target.name }; },
  }, { cwd: "/runtime", toolTimeoutMs: options.timeoutMs });
  engine.loadMessages([{ type: "user", content: "existing conversation" }]);
  const call = () => engine.executeTool({ type: "tool_use", id: "proxy-call", name: "McpToolCall", input: { serverName: "remote", toolName: "query", args: { text: "hello" } } }, { execution });
  return { call, engine, execution, registry, controller, events, checked, hooks, modelMessages, get calls() { return calls; } };
}

describe("MCP proxy authorization", () => {
  it("executes one trusted app-only captured tool through the checked pipeline while model/proxy stay denied", async () => {
    const f = fixture();
    const binding = f.execution.tools!.get("mcp__remote__query")!;
    binding.definition.ui = { visibility: ["app"] };
    const call = { type: "tool_use" as const, id: "app-call", name: binding.definition.name, input: { text: "hello" } };
    const modelTools=new Map([...f.execution.tools!].filter(([name])=>name!==binding.definition.name));
    f.execution.tools=modelTools;
    expect((await f.engine.executeTool(call,{execution:f.execution})).executionState).toBe("not_started");
    f.execution.tools=new Map([[binding.definition.name,binding]]);
    expect((await f.engine.executeTool(call,{execution:f.execution})).executionState).toBe("completed");
    expect(f.checked).toContain(binding.definition.name);
    expect(f.hooks).toContain(`pre_tool_use:${binding.definition.name}`);
    f.execution.tools=modelTools;
    expect((await f.engine.executeTool(call, { execution: f.execution })).executionState).toBe("not_started");
    expect((await f.call()).executionState).toBe("unknown");
    expect(f.calls).toBe(1);
  });
  it("does not let app visibility override the actual tool permission deny", async () => {
    const f = fixture({ decision: "deny" });
    const binding = f.execution.tools!.get("mcp__remote__query")!;
    binding.definition.ui = { visibility: ["app"] };
    f.execution.tools=new Map([[binding.definition.name,binding]]);
    expect(await f.engine.executeTool({ type: "tool_use", id: "app-denied", name: binding.definition.name, input: { text: "hi" } },
      { execution: f.execution })).toMatchObject({ isError: true, failureKind: "permission", executionState: "not_started" });
    expect(f.checked).toEqual([binding.definition.name]);
    expect(f.calls).toBe(0);
  });
  it.each(["model", "app", "both"] as const)("enforces %s visibility in captured direct/proxy calls and descriptors", async audience => {
    const f = fixture();
    const binding = f.execution.tools!.get("mcp__remote__query")!;
    binding.definition.ui = { visibility: audience === "both" ? ["model", "app"] : [audience] };
    const registry = runToolRegistry(f.registry, null, undefined, f.execution.tools);
    expect(toolRegistryView(registry).has(binding.definition.name)).toBe(audience !== "app");
    if (audience !== "app") expect(toolRegistryView(registry).get(binding.definition.name)?.ui).toEqual(binding.definition.ui);
    if(audience==="app")f.execution.tools=new Map([...f.execution.tools!].filter(([name])=>name!==binding.definition.name));
    const result = await f.call();
    // The proxy was invoked even when the captured target was unavailable.
    expect(result.executionState).toBe(audience === "app" ? "unknown" : "completed");
    expect(f.calls).toBe(audience === "app" ? 0 : 1);
    const direct = await f.engine.executeTool({ type: "tool_use", id: "direct", name: binding.definition.name, input: { text: "hi" } }, { execution: f.execution });
    expect(direct.executionState).toBe(audience === "app" ? "not_started" : "completed");
  });

  it("hides app-only tools from search even without a resource and rejects malformed visibility", () => {
    const registry = new ToolRegistry();
    const search: ToolDefinition = { name: "Search", description: "search", inputSchema: {}, execute: async () => ({ content: [] }) };
    registry.register(search, { kind: "builtin" });
    for (const [name, visibility] of [["private", ["app"]], ["invalid", ["model", "invalid"]], ["public", ["model", "app"]]] as const) {
      registry.register({ ...search, name, ui: { visibility: visibility as unknown as Array<"model" | "app"> } });
    }
    const discovery = RunToolDiscovery.create(registry, { searchTool: search, shouldDefer: () => true, minToolCount: 1 })!;
    expect(discovery.catalog.map(row => row.name)).toEqual(["Search", "public"]);
    expect(discovery.expose(["private", "invalid", "public"])).toEqual(["public"]);
    expect(discovery.requestRegistry([], false).getAll().map(tool => tool.name)).toEqual(["Search", "public"]);
  });
  it("cannot use the host MCP manager to bypass a visible target's formal deny", async () => {
    const f = fixture({ modelLoop: true, decision: "deny" });
    f.execution.tools = undefined;
    let rawCalls = 0;
    expect("setMcpManager" in f.engine).toBe(false);
    for await (const _event of f.engine.submitMessage("query MCP", { execution: f.execution })) { /* consume */ }
    const result = f.engine.getHistory().find(message => message.type === "tool_result");
    expect(result).toMatchObject({ isError: true, failureKind: "permission", executionState: "unknown" });
    expect(rawCalls).toBe(0);
    expect(f.calls).toBe(0);
    expect(f.checked).toContain("mcp__remote__query");
  });
  it("persists only the model-issued proxy call and matching result in canonical history", async () => {
    const f = fixture({ modelLoop: true });
    for await (const _event of f.engine.submitMessage("query MCP", { execution: f.execution })) { /* consume */ }
    const history = f.engine.getHistory();
    const calls = history.flatMap(message => message.type === "assistant" ? message.toolUses ?? [] : []);
    const results = history.filter(message => message.type === "tool_result");
    expect(calls.map(call => [call.id, call.name])).toEqual([["proxy-call", "McpToolCall"]]);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ toolUseId: "proxy-call", content: [{ type: "text", text: "captured hello" }] });
    expect(f.modelMessages).toHaveLength(2);
    expect(f.modelMessages[1]!.filter(message => message.type === "tool_result")).toHaveLength(1);
    expect(f.calls).toBe(1);
  });
  it("calls the captured MCP binding and leaves history and lifecycle paired to the proxy", async () => {
    const f = fixture();
    const before = structuredClone(f.engine.getHistory());
    expect(await f.call()).toMatchObject({ content: [{ type: "text", text: "captured hello" }], executionState: "completed" });
    expect(f.calls).toBe(1);
    expect(f.checked).toEqual(["McpToolCall", "mcp__remote__query"]);
    expect(f.hooks).toContain("pre_tool_use:mcp__remote__query");
    expect(f.hooks).toContain("post_tool_use:mcp__remote__query");
    expect(f.engine.getHistory()).toEqual(before);
    const lifecycles = f.events.filter(event => event.type === "domain.event" && event.data.name === "tool.lifecycle");
    expect(lifecycles.every(event => event.type === "domain.event" && (event.data.payload as { toolUseId: string }).toolUseId === "proxy-call")).toBe(true);
  });

  it.each([{ captured: false }, { source: "agent" as const }])("rejects a missing or non-MCP captured target %j", async options => {
    const f = fixture(options);
    expect(await f.call()).toMatchObject({ isError: true, executionState: "unknown" });
    expect(f.calls).toBe(0);
    expect(f.checked).toEqual(["McpToolCall"]);
  });

  it("honors a formal deny while the target remains visible", async () => {
    const f = fixture({ decision: "deny" });
    expect(f.registry.has("mcp__remote__query")).toBe(true);
    expect(await f.call()).toMatchObject({ isError: true, failureKind: "permission", executionState: "unknown" });
    expect(f.calls).toBe(0);
    expect(f.checked).toContain("mcp__remote__query");
  });

  it.each([true, false])("uses ordinary persisted approval (approved=%s)", async approved => {
    const f = fixture({ decision: "ask", approved });
    expect(await f.call()).toMatchObject(approved ? { executionState: "completed" } : { isError: true, failureKind: "permission", executionState: "unknown" });
    expect(f.calls).toBe(approved ? 1 : 0);
    expect(f.events.map(event => event.type)).toContain("permission.requested");
    expect(f.events.map(event => event.type)).toContain("permission.resolved");
  });

  it("honors target pre-tool hooks", async () => {
    const f = fixture({ blocked: true });
    expect(await f.call()).toMatchObject({ isError: true, failureKind: "policy", executionState: "unknown" });
    expect(f.calls).toBe(0);
  });

  it("propagates outer cancellation to the actual MCP target", async () => {
    let targetSignal: AbortSignal | undefined;
    const f = fixture({ invoke: async (_input, context) => { targetSignal = context.abortSignal; f.controller.abort(new Error("cancelled")); return new Promise(() => {}); } });
    expect(await f.call()).toMatchObject({ isError: true, failureKind: "interrupted", executionState: "unknown" });
    expect(f.calls).toBe(1);
    expect(targetSignal?.aborted).toBe(true);
  });

  it("bounds the actual MCP target by the outer deadline", async () => {
    vi.useFakeTimers();
    let targetSignal: AbortSignal | undefined;
    const f = fixture({ timeoutMs: 10, invoke: async (_input, context) => { targetSignal = context.abortSignal; return new Promise(() => {}); } });
    const pending = f.call();
    await vi.advanceTimersByTimeAsync(11);
    expect(await pending).toMatchObject({ isError: true, failureKind: "timeout", executionState: "unknown" });
    expect(f.calls).toBe(1);
    expect(targetSignal?.aborted).toBe(true);
  });
});

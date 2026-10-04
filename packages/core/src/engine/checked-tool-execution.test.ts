import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AgentEventInput, AgentExecutionContext, IHookExecutor, IPermissionChecker,
  StreamEvent, ToolContext, ToolDefinition, ToolUseBlock,
} from "../index.js";
import { QueryEngine } from "./query-engine.js";
import { ToolRegistry } from "./tool-registry.js";

afterEach(() => vi.useRealTimers());

function fixture(options: {
  invoke?: ToolDefinition["execute"];
  permission?: IPermissionChecker["checkTool"];
  hook?: IHookExecutor["execute"];
  toolTimeoutMs?: number;
} = {}) {
  const inputs: Record<string, unknown>[] = [];
  const contexts: ToolContext[] = [];
  const checked: Record<string, unknown>[] = [];
  const hooks: string[] = [];
  const events: AgentEventInput[] = [];
  const controller = new AbortController();
  let clientCalls = 0;
  const definition: ToolDefinition = {
    name: "Inspect", description: "Native plugin fixture",
    inputSchema: { type: "object", properties: {
      text: { type: "string" }, text_from: { type: "string" },
    }, required: ["text"] },
    inputReuse: { property: "text", referenceProperty: "text_from" },
    execute: async () => { throw new Error("uncaptured definition invoked"); },
  };
  const registry = new ToolRegistry();
  registry.register(definition, { kind: "plugin", id: "native" });
  const execution: AgentExecutionContext = {
    scope: { agentId: "a", sessionId: "s", runId: "r", inputId: "i",
      cwd: "/untrusted", traceId: "t", signal: controller.signal },
    capabilityView: {
      pluginId: "native", tools: new Map([["Inspect", {
        ownerPluginId: "native", definition, source: { kind: "plugin", id: "native" },
        invoke: async (input, context) => {
          inputs.push({ ...input }); contexts.push(context);
          return options.invoke?.(input, context) ?? {
            content: [{ type: "text", text: String(input.text) }], compactSummary: "untrusted summary",
          };
        },
      }]]), skills: new Map(), mcpServers: new Map(), agents: new Map(),
    },
    effects: { requestPermission: async () => ({ status: "approved" }) },
    children: {
      hasChildAgent: () => false,
      spawnChildAgent: async () => { throw new Error("unexpected child"); },
      sendChildInput: async () => { throw new Error("unexpected child"); },
      interruptChildAgent: async () => {},
      awaitChildAgent: async () => { throw new Error("unexpected child"); },
    },
    emit: async event => { events.push(event); },
    takeSteeredInputs: async () => [], closeSteering() {},
  };
  const engine = new QueryEngine({ streamMessage: async function* (): AsyncIterable<StreamEvent> {
    clientCalls++; yield { type: "complete", stopReason: "end_turn" };
  } }, registry, { checkTool: async (...args) => {
    checked.push({ ...args[1] });
    return options.permission?.(...args) ?? { action: "allow" };
  } }, { register() {}, execute: async (...args) => {
    hooks.push(args[0]); return options.hook?.(...args) ?? { blocked: false };
  } }, { cwd: "/runtime", toolTimeoutMs: options.toolTimeoutMs });
  engine.loadMessages([
    { type: "user", content: "old conversation" },
    { type: "assistant", content: "", toolUses: [{ type: "tool_use", id: "old", name: "Inspect", input: { text: "private old input" } }] },
    { type: "tool_result", toolUseId: "old", content: [{ type: "text", text: "old output" }] },
  ]);
  const toolUse: ToolUseBlock = { type: "tool_use", id: "ui-call", name: "Inspect", input: { text: "hello" } };
  return { engine, execution, toolUse, inputs, contexts, checked, hooks, events, controller,
    get clientCalls() { return clientCalls; } };
}

describe("history-free checked tool execution", () => {
  it("invokes the captured Native plugin without model requests or history/usage changes", async () => {
    const f = fixture();
    const before = structuredClone(f.engine.getHistory());
    const usage = f.engine.getTotalUsage();
    const result = await f.engine.executeTool(f.toolUse, { execution: f.execution });
    expect(result.content).toEqual([{ type: "text", text: "hello" }]);
    expect(result.executionState).toBe("completed");
    expect(result.compactSummary).toBeUndefined();
    expect(f.inputs).toEqual([{ text: "hello" }]);
    expect(f.contexts[0]).toMatchObject({ cwd: "/runtime", toolCallId: "ui-call", toolAttemptId: "tool_attempt_ui-call_1" });
    expect(f.checked).toEqual([{ text: "hello" }]);
    expect(f.hooks).toEqual(["pre_tool_use", "post_tool_use"]);
    expect(f.clientCalls).toBe(0);
    expect(f.engine.getHistory()).toEqual(before);
    expect(f.engine.getTotalUsage()).toEqual(usage);
  });

  it.each(["missing_view", "missing_tool", "contribution"])("fails closed for %s without using the global registry", async mode => {
    const f = fixture();
    const execution = { ...f.execution, capabilityView: mode === "missing_view" ? undefined : {
      ...f.execution.capabilityView!, tools: new Map(),
    }, contribution: mode === "contribution" ? {
      tools: [{ definition: { ...f.execution.capabilityView!.tools.get("Inspect")!.definition,
        execute: async () => { throw new Error("contribution invoked"); } }, permission: "host-internal" as const }],
    } : undefined };
    expect(await f.engine.executeTool(f.toolUse, { execution })).toMatchObject({ isError: true, executionState: "not_started" });
    expect(f.inputs).toEqual([]);
    expect(f.checked).toEqual([]);
    expect(f.clientCalls).toBe(0);
  });

  it("does not mutate a retained historical call while normalizing its explicit input", async () => {
    const f = fixture();
    const historicalCall: ToolUseBlock = { ...f.toolUse, input: { arguments: { text: "explicit" } } };
    f.engine.loadMessages([{ type: "assistant", content: "", toolUses: [historicalCall] }]);
    const before = structuredClone(f.engine.getHistory());
    expect(await f.engine.executeTool(historicalCall, { execution: f.execution })).toMatchObject({
      content: [{ type: "text", text: "explicit" }], executionState: "completed",
    });
    expect(f.inputs).toEqual([{ text: "explicit" }]);
    expect(f.engine.getHistory()).toEqual(before);
  });

  it.each(["invalid", "reuse", "permission", "hook"])("prevents side effects after %s rejection", async mode => {
    const f = fixture({ permission: async () => ({ action: mode === "permission" ? "deny" : "allow" }),
      hook: async () => ({ blocked: mode === "hook" }) });
    if (mode === "invalid") f.toolUse.input = { text: [] };
    if (mode === "reuse") f.toolUse.input = { text_from: "old" };
    const before = structuredClone(f.engine.getHistory());
    const result = await f.engine.executeTool(f.toolUse, { execution: f.execution });
    expect(result).toMatchObject({ isError: true, executionState: "not_started",
      failureKind: mode === "permission" ? "permission" : mode === "hook" ? "policy" : "invalid_input" });
    expect(f.inputs).toEqual([]);
    if (mode === "invalid" || mode === "reuse") expect(f.checked).toEqual([]);
    expect(f.engine.getHistory()).toEqual(before);
  });

  it("uses ordinary approval before invocation", async () => {
    const f = fixture({ permission: async () => ({ action: "ask" }) });
    let approved = false;
    f.execution.effects.requestPermission = async request => {
      expect(request.input).toEqual({ text: "hello" }); expect(f.inputs).toEqual([]);
      approved = true; return { status: "approved" };
    };
    expect(await f.engine.executeTool(f.toolUse, { execution: f.execution })).toMatchObject({ executionState: "completed" });
    expect(approved).toBe(true);
    expect(f.events.map(event => event.type)).toContain("permission.resolved");
  });

  it("records scope cancellation before invocation as not_started", async () => {
    const f = fixture(); f.controller.abort(new Error("cancelled"));
    expect(await f.engine.executeTool(f.toolUse, { execution: f.execution })).toMatchObject({ failureKind: "interrupted", executionState: "not_started" });
    expect(f.inputs).toEqual([]);
  });

  it.each(["scope", "signal"])("records %s cancellation during invocation as unknown", async source => {
    const signalController = new AbortController();
    const f = fixture({ invoke: async () => {
      (source === "scope" ? f.controller : signalController).abort(new Error("cancelled"));
      return new Promise(() => {});
    } });
    expect(await f.engine.executeTool(f.toolUse, { execution: f.execution, signal: signalController.signal }))
      .toMatchObject({ failureKind: "interrupted", executionState: "unknown" });
    expect(f.inputs).toEqual([{ text: "hello" }]);
    expect(f.contexts[0]!.abortSignal!.aborted).toBe(true);
    expect(f.hooks).toEqual(["pre_tool_use"]);
  });

  it("reports timeout with an unknown outcome and aborts the invocation", async () => {
    vi.useFakeTimers();
    const f = fixture({ toolTimeoutMs: 10, invoke: async () => new Promise(() => {}) });
    const pending = f.engine.executeTool(f.toolUse, { execution: f.execution });
    await vi.advanceTimersByTimeAsync(11);
    expect(await pending).toMatchObject({ failureKind: "timeout", executionState: "unknown" });
    expect(f.contexts[0]!.abortSignal!.aborted).toBe(true);
    expect(f.hooks).toEqual(["pre_tool_use", "post_tool_use"]);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentEventInput, AgentExecutionContext, HookExecutor as IHookExecutor, PermissionChecker as IPermissionChecker, StreamEvent, ToolContext, ToolDefinition, ToolRegistrationSource } from "@vykor/agent-contracts";
import type { ToolUseBlock } from "@vykor/agent-contracts";
import { QueryEngine } from "./query-engine.js";
import { ToolRegistry } from "./tool-registry.js";
import { AgentExecutionLimitError } from "@vykor/agent-contracts";

afterEach(() => vi.useRealTimers());

function fixture(options: {
  invoke?: ToolDefinition["execute"];
  permission?: IPermissionChecker["checkTool"];
  hook?: IHookExecutor["execute"];
  toolTimeoutMs?: number;
  source?: ToolRegistrationSource;
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
  registry.register(definition, options.source ?? { kind: "plugin", id: "native" });
  const execution: AgentExecutionContext = {
    profile:{toolResultReferences:true},
    scope: { agentId: "a", sessionId: "s", runId: "r", inputId: "i",
      cwd: "/untrusted", traceId: "t", signal: controller.signal },
    tools: new Map([["Inspect", {
        definition, source: options.source ?? { kind: "plugin", id: "native" },
        invoke: async (input, context) => {
          inputs.push({ ...input }); contexts.push(context);
          return options.invoke?.(input, context) ?? {
            content: [{ type: "text", text: String(input.text) }], compactSummary: "untrusted summary",
          };
        },
      }]]),
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
  it("keeps original MCP data for persistence while post hooks only receive public tool feedback", async () => {
    const raw = { content: [{ type: "text", text: "saved" }], structuredContent: { revision: 2 }, _meta: { uiOnly: { cursor: 8 } }, isError: false };
    const hookPayloads: unknown[] = [];
    const f = fixture({ invoke: async () => ({ content: [{ type: "text", text: "saved" }], mcpResult: raw, metadata: { appData: { privateView: true }, requestId: "forged", controlRevision: 99 } }),
      hook: async (_event, payload) => { hookPayloads.push(payload); return { blocked: false }; } });
    const result = await f.engine.executeTool(f.toolUse, { execution: f.execution });
    expect(result.mcpResult).toEqual(raw);
    expect(result.executionState).toBe("completed");
    expect(result.metadata?.requestId).toBeUndefined();
    expect(result.metadata?.controlRevision).toBeUndefined();
    expect(JSON.stringify(hookPayloads)).not.toMatch(/uiOnly|privateView|mcpResult/);
    expect(JSON.stringify(f.engine.getHistory())).not.toContain("uiOnly");
    // Cross-tool import intentionally retains content only, not the page-private result.
    expect(f.contexts[0]!.readToolResult?.(f.toolUse.id)?.mcpResult).toBeUndefined();
  });

  it("does not label a returned malformed MCP response as an unstarted tool", async () => {
    const f = fixture({ invoke: async () => ({ content: [{ type: "text", text: "saved" }], mcpResult: { content: [], _meta: { bad: NaN } } }) });
    expect(await f.engine.executeTool(f.toolUse, { execution: f.execution })).toMatchObject({ isError: true, executionState: "unknown" });
    expect(f.inputs).toHaveLength(1);
  });
  it.each(["plugin", "builtin"] as const)("only raises captured builtin file facts into host feedback: %s", async kind => {
    const facts = { environmentKey: "local:/runtime", files: [{ path: "/runtime/file", subjectKey: "file-1",
      operation: "read", afterDigest: `sha256:${"a".repeat(64)}`, completed: true, bodyVisible: true }] };
    const forged = { ...facts, environmentKey: "forged" };
    const f = fixture({ source: kind === "builtin" ? { kind: "builtin" } : { kind: "plugin", id: "native" },
      invoke: async () => ({ content: [{ type: "text", text: "observed" }],
        hostFileFacts: forged, metadata: { hostFileFacts: facts } }),
    });
    const result = await f.engine.executeTool(f.toolUse, { execution: f.execution });
    expect(result.metadata?.hostFileFacts).toBeUndefined();
    expect((result as unknown as { hostFileFacts?: unknown }).hostFileFacts).toEqual(kind === "builtin" ? facts : undefined);
  });
  it("skips executable hooks while preserving permission checks and a trusted tool descriptor", async () => {
    const f = fixture();
    const descriptors: unknown[] = [];
    const context = { ...f.execution, profile: { executableHooks: false }, limits: {
      check: async (boundary: string, tool?: unknown) => { descriptors.push({ boundary, tool }); },
    } };
    await f.engine.executeTool(f.toolUse, { execution: context });
    expect(f.checked).toEqual([{ text: "hello" }]);
    expect(f.inputs).toEqual([{ text: "hello" }]);
    expect(f.hooks).toEqual([]);
    expect(descriptors).toEqual([{ boundary: "tool", tool: { toolName: "Inspect", toolAttemptId: "tool_attempt_ui-call_1" } }]);
  });
  it("propagates a child boundary limit raised inside a running tool", async () => {
    const limit = new AgentExecutionLimitError("child closed");
    const f = fixture({ invoke: async () => { throw limit; } });
    await expect(f.engine.executeTool(f.toolUse, { execution: f.execution })).rejects.toBe(limit);
  });
  it("rechecks the host limit after approval and before invocation", async () => {
    let approved = false;
    const limit = new AgentExecutionLimitError("closed during approval");
    const f = fixture({ permission: async () => { approved = true; return { action: "allow" }; } });
    const execution = { ...f.execution, limits: { check: async (boundary: string) => {
      expect(boundary).toBe("tool"); expect(approved).toBe(true); throw limit;
    } } };
    await expect(f.engine.executeTool(f.toolUse, { execution })).rejects.toBe(limit);
    expect(f.inputs).toEqual([]);
    expect(f.events.some(event => event.type === "domain.event" && event.data.payload?.executionState === "not_started")).toBe(true);
  });
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
    const execution = { ...f.execution, tools: mode === "missing_view" ? undefined : new Map(), contribution: mode === "contribution" ? {
      tools: [{ definition: { ...f.execution.tools!.get("Inspect")!.definition,
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

it.each(["post-hook", "terminal-lifecycle"])("delivers a collected result exactly once before propagating %s failure", async failureAt => {
  const failure = new Error(failureAt);
  const f = fixture({ invoke: async () => ({ content: [{ type: "text", text: "Saved" }], isError: true, executionState: "completed", metadata: { appData: { saved: true } } }),
    hook: async event => { if (failureAt === "post-hook" && event === "post_tool_use") throw failure; return { blocked: false }; } });
  if (failureAt === "terminal-lifecycle") f.execution.emit = async event => {
    if (event.type === "domain.event" && event.data.name === "tool.lifecycle" && event.data.payload?.phase === "failed") throw failure;
  };
  const delivered = vi.fn(async (_result: import("../types/tools.js").ToolExecutionResult) => {});
  await expect(f.engine.executeTool(f.toolUse, { execution: f.execution, onResult: delivered })).rejects.toBe(failure);
  expect(delivered).toHaveBeenCalledTimes(1);
  expect(delivered.mock.calls[0]![0]).toMatchObject({ content: [{ type: "text", text: "Saved" }], isError: true, executionState: "completed", metadata: { appData: { saved: true } } });
  expect(f.inputs).toHaveLength(1);
});
it("propagates result delivery failure once and retains both delivery and hook errors", async () => {
  const saveFailure = new Error("disk save failed"), hookFailure = new Error("post hook failed");
  for (const hookFails of [false, true]) {
    const f = fixture({ hook: async event => { if (hookFails && event === "post_tool_use") throw hookFailure; return { blocked: false }; } });
    const delivered = vi.fn(async () => { throw saveFailure; });
    const call = f.engine.executeTool(f.toolUse, { execution: f.execution, onResult: delivered });
    if (hookFails) await expect(call).rejects.toMatchObject({ errors: [hookFailure, saveFailure] });
    else await expect(call).rejects.toBe(saveFailure);
    expect(delivered).toHaveBeenCalledTimes(1); expect(f.inputs).toHaveLength(1);
  }
});

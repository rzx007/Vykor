import { expect, it, vi } from "vitest";
import { authorizeToolCall } from "./query-tool-permissions.js";
import type { AgentExecutionContext, RunToolBinding } from "../types/runtime.js";
import { QueryEngine } from "./query-engine.js";
import { ToolRegistry } from "./tool-registry.js";

it("uses only the exact original app Run grant and preserves deny and hooks", async () => {
  const tool = { name: "Save", description: "Save", inputSchema: {}, execute: async () => ({ content: [] }) };
  const binding = { ownerPluginId: "p", definition: tool, definitionIdentity: Symbol("identity"), invoke: tool.execute } as RunToolBinding;
  const call = { idx: 0, tool, toolUse: { type: "tool_use" as const, id: "call", name: "Save", input: { documentId: "d" } } };
  const requestPermission = vi.fn(async () => ({ status: "denied" }));
  const execution = { scope: { runId: "run" }, capabilityView: { tools: new Map([["Save", binding]]), appTools: new Map([["Save", binding]]) },
    pluginAppToolApproval: { runId: "run", toolUseId: "call", binding, argumentsJson: JSON.stringify(call.toolUse.input) },
    effects: { requestPermission }, emit: async () => {} } as unknown as AgentExecutionContext;
  const hook = { execute: vi.fn(async () => ({ blocked: false })) };
  const ask = { checkTool: async () => ({ action: "ask" as const }) };
  expect(await authorizeToolCall(call, ask, hook as never, execution, new Set())).toBeUndefined();
  expect(requestPermission).not.toHaveBeenCalled();
  expect(hook.execute).toHaveBeenCalledOnce();
  const denied = await authorizeToolCall(call, { checkTool: async () => ({ action: "deny" as const }) }, hook as never, execution, new Set());
  expect(denied?.failureKind).toBe("permission");
  hook.execute.mockResolvedValueOnce({ blocked: true });
  expect((await authorizeToolCall(call, ask, hook as never, execution, new Set()))?.failureKind).toBe("policy");
  expect((await authorizeToolCall({ ...call, toolUse: { ...call.toolUse, input: { documentId: "foreign" } } }, ask, hook as never, execution, new Set()))?.failureKind).toBe("permission");
  expect(requestPermission).toHaveBeenCalledOnce();
});

it("does not lend an app approval to a model-audience tool call using the same binding", async () => {
  const execute = vi.fn(async () => ({ content: [] }));
  const tool = { name: "Save", description: "Save", inputSchema: { type: "object" }, execute };
  const binding: RunToolBinding = { ownerPluginId: "p", definition: tool, invoke: execute };
  const toolUse = { type: "tool_use" as const, id: "call", name: "Save", input: {} };
  const requestPermission = vi.fn(async () => ({ status: "denied" }));
  const execution = { scope: { runId: "run", signal: new AbortController().signal },
    capabilityView: { tools: new Map([["Save", binding]]), appTools: new Map([["Save", binding]]) },
    pluginAppToolApproval: { runId: "run", toolUseId: "call", binding, argumentsJson: "{}" },
    effects: { requestPermission }, emit: async () => {} } as unknown as AgentExecutionContext;
  const registry = new ToolRegistry(); registry.register(tool, { kind: "plugin", id: "p" });
  const engine = new QueryEngine({ async *streamMessage() { throw new Error("model must not be called"); } }, registry,
    { checkTool: async () => ({ action: "ask" }) }, { execute: async () => ({ blocked: false }), register() {} } as never);
  expect((await engine.executeTool(toolUse, { audience: "model", execution })).failureKind).toBe("permission");
  expect(execute).not.toHaveBeenCalled(); expect(requestPermission).toHaveBeenCalledOnce();
});

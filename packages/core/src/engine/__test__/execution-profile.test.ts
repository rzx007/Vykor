import { describe, expect, it } from "vitest";
import { QueryEngine } from "../query-engine.js";
import { ToolRegistry } from "../tools/tool-registry.js";
import { ModelRequestFailure } from "@vykor/agent-contracts";
import type { AgentExecutionContext, StreamMessageParams, ToolDefinition } from "@vykor/agent-contracts";

function execution(extra: Partial<AgentExecutionContext> = {}): AgentExecutionContext {
  return { scope: { signal: new AbortController().signal }, emit: async () => {},
    takeSteeredInputs: async () => [], closeSteering: () => {}, ...extra } as AgentExecutionContext;
}

describe("run execution profile", () => {
  it("keeps the cap during provider changes and the reserved final request", async () => {
    const requests: StreamMessageParams[] = [];
    const registry = new ToolRegistry();
    registry.register({ name: "Read", description: "read", inputSchema: {}, execute: async () => ({ content: [] }) });
    const client = { streamMessage: async function* (params: StreamMessageParams) {
      requests.push(params);
      if (requests.length === 1) yield { type: "tool_use_start" as const,
        toolUse: { type: "tool_use" as const, id: "r", name: "Read", input: {} } };
      yield { type: "complete" as const, stopReason: requests.length === 1 ? "tool_use" : "end_turn" };
    } };
    let revision = 0;
    const engine = new QueryEngine(client, registry, { checkTool: async () => ({ action: "allow" }) },
      { execute: async () => ({ blocked: false }) } as never, { resolveRequestConfiguration: async () => ({
        revision: revision++, model: revision === 1 ? "first" : "second", provider: revision === 1 ? "a" : "b",
        client, maxOutputTokens: revision === 1 ? 512 : 32_000,
      }) });
    await expect((async () => {
      for await (const _ of engine.submitMessage("prepare", { execution: execution({ hardMaxTurns: 2,
        profile: { maxOutputTokens: 1024 },
      }) })) { /* drain */ }
    })()).rejects.toThrow("Exceeded maximum agentic turns (2)");
    expect(requests.map(request => request.maxTokens)).toEqual([512, 1024]);
    expect(requests.map(request => request.model)).toEqual(["first", "second"]);
    expect(requests[1]?.tools).toBeUndefined();
  });

  it("caps retry and compaction requests and suppresses executable hooks", async () => {
    const requests: StreamMessageParams[] = [];
    const hooks: string[] = [];
    let failedGeneration = false;
    const client = { streamMessage: async function* (params: StreamMessageParams) {
      requests.push(params);
      if (params.system !== "You are a conversation summarizer." && !failedGeneration) {
        failedGeneration = true;
        throw new ModelRequestFailure("temporary", { kind: "network", phase: "stream", retryable: true });
      }
      yield { type: "text_delta" as const, delta: params.system === "You are a conversation summarizer." ? "<summary>summary</summary>" : "summary" };
      yield { type: "complete" as const, stopReason: "end_turn" };
    } };
    const engine = new QueryEngine(client, new ToolRegistry(), { checkTool: async () => ({ action: "allow" }) },
      { execute: async (event: string) => { hooks.push(event); return { blocked: false }; } } as never,
      { maxTokens: 25_000, compactKeepRecent: 1, modelRetry: { baseDelayMs: 1, maxDelayMs: 1 },
        resolveRequestConfiguration: async () => ({ revision: 1, model: "m", client, maxOutputTokens: 32_000 }) });
    engine.loadMessages(Array.from({ length: 12 }, (_, i) => ({ type: i % 2 ? "assistant" as const : "user" as const,
      content: `message ${i} ` + "abcdefgh ".repeat(1400) })));
    for await (const _ of engine.submitMessage("prepare", { execution: execution({
      profile: { maxOutputTokens: 1024, executableHooks: false },
    } as never) })) { /* drain */ }
    expect(requests.some(request => request.system === "You are a conversation summarizer.")).toBe(true);
    expect(requests.filter(request => request.system !== "You are a conversation summarizer.")).toHaveLength(2);
    expect(requests.every(request => request.maxTokens === 1024)).toBe(true);
    expect(hooks).toEqual([]);
  });

  it("delivers the entire batch then ends on a successful trusted contribution", async () => {
    const saved: string[] = [];
    let calls = 0;
    let closed = false;
    const registry = new ToolRegistry();
    registry.register({ name: "Read", description: "read", inputSchema: {},
      execute: async () => ({ content: [{ type: "text", text: "file" }] }) });
    const assessment: ToolDefinition = { name: "GoalAssessment", description: "host", inputSchema: {},
      execute: async () => ({ content: [{ type: "text", text: "recorded" }] }) };
    const engine = new QueryEngine({ streamMessage: async function* () {
      calls++;
      if (calls === 1) for (const name of ["GoalAssessment", "Read"]) {
        yield { type: "tool_use_start" as const, toolUse: { type: "tool_use" as const, id: name, name, input: {} } };
      }
      yield { type: "complete" as const, stopReason: calls === 1 ? "tool_use" : "end_turn" };
    } }, registry, { checkTool: async () => ({ action: "allow" }) }, { execute: async () => ({ blocked: false }) } as never);
    for await (const event of engine.submitMessage("prepare", { execution: execution({
      contribution: { tools: [{ definition: assessment, permission: "host-internal", endRunOnSuccess: true } as never] },
      closeSteering: () => { closed = true; },
    }) })) if (event.type === "tool_use_end") saved.push(event.toolUseId);
    expect(saved).toEqual(["GoalAssessment", "Read"]);
    expect(engine.getHistory().filter(message => message.type === "tool_result")).toHaveLength(2);
    expect(calls).toBe(1);
    expect(closed).toBe(true);
  });

  it.each(["cancel", "hook_failure"] as const)("delivers the complete committed batch before propagating %s", async mode => {
    const stop = new Error(mode);
    const controller = new AbortController();
    const delivered: string[] = [];
    const registry = new ToolRegistry();
    registry.register({ name: "Read", description: "read", inputSchema: {}, execute: async () => ({ content: [] }) });
    const assessment: ToolDefinition = { name: "GoalAssessment", description: "host", inputSchema: {}, execute: async () => ({ content: [] }) };
    let calls = 0;
    const engine = new QueryEngine({ streamMessage: async function* () {
      calls++;
      for (const name of ["GoalAssessment", "Read"]) yield { type: "tool_use_start" as const,
        toolUse: { type: "tool_use" as const, id: name, name, input: {} } };
      yield { type: "complete" as const, stopReason: "tool_use" };
    } }, registry, { checkTool: async () => ({ action: "allow" }) }, {
      execute: async (name: string) => { if (mode === "hook_failure" && name === "post_tool_use") throw stop; return { blocked: false }; },
    } as never);
    await expect((async () => {
      for await (const event of engine.submitMessage("prepare", { execution: execution({
        scope: { signal: controller.signal } as AgentExecutionContext["scope"],
        contribution: { tools: [{ definition: assessment, permission: "host-internal", endRunOnSuccess: true }] },
      }) })) if (event.type === "tool_use_end") {
        delivered.push(event.toolUseId);
        if (mode === "cancel") controller.abort(stop);
      }
    })()).rejects.toBe(stop);
    expect(delivered).toEqual(["GoalAssessment", "Read"]);
    expect(engine.getHistory().filter(message => message.type === "tool_result")).toHaveLength(2);
    expect(calls).toBe(1);
  });

  it("does not end because an ordinary tool claims the flag in metadata", async () => {
    let calls = 0;
    const registry = new ToolRegistry();
    registry.register({ name: "GoalAssessment", description: "ordinary", inputSchema: {}, execute: async () => ({ content: [], metadata: { endRunOnSuccess: true } }) });
    const engine = new QueryEngine({ streamMessage: async function* () {
      calls++;
      if (calls === 1) yield { type: "tool_use_start" as const,
        toolUse: { type: "tool_use" as const, id: "ordinary", name: "GoalAssessment", input: {} } };
      yield { type: "complete" as const, stopReason: calls === 1 ? "tool_use" : "end_turn" };
    } }, registry, { checkTool: async () => ({ action: "allow" }) }, { execute: async () => ({ blocked: false }) } as never);
    for await (const _ of engine.submitMessage("ordinary")) { /* drain */ }
    expect(calls).toBe(2);
  });
});

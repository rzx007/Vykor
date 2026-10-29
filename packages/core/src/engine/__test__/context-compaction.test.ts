import { describe, expect, it } from "vitest";
import {
  AgentExecutionLimitError,
  ModelRequestFailure,
  type AgentEventInput,
  type AgentExecutionContext,
  type Message,
  type StreamEvent,
  type StreamingMessageClient,
  type StreamMessageParams,
} from "@vykor/agent-contracts";
import { QueryEngine } from "../query-engine.js";
import { ToolRegistry } from "../tools/tool-registry.js";

const hooks = { execute: async () => ({ blocked: false }) } as any;
const permissions = { checkTool: async () => ({ action: "allow" as const, reason: "test" }) };
const scope = {
  agentId: "agent-test", sessionId: "session-test", inputId: "input-test",
  runId: "run-test", traceId: "trace-test", cwd: "/work", signal: new AbortController().signal,
};

function history(): Message[] {
  return Array.from({ length: 60 }, (_, i) => ({
    type: i % 2 === 0 ? "user" as const : "assistant" as const,
    content: `message ${i}: ${"x".repeat(1000)}`,
  }));
}

function overflow(phase: "request" | "stream" = "request"): ModelRequestFailure {
  return new ModelRequestFailure(
    "400 Upstream request failed: [context_length_exceeded] This model configuration accepts at most 1048576 combined input and output tokens. However, your request has 985107 input tokens and asks for 65536 output tokens.",
    { kind: "invalid_request", phase, retryable: false, statusCode: 400 },
  );
}

async function collect(engine: QueryEngine, options?: Parameters<QueryEngine["submitMessage"]>[1]) {
  const events: StreamEvent[] = [];
  for await (const event of engine.submitMessage("Continue; preserve the source files.", options)) events.push(event);
  return events;
}

describe("request context compaction", () => {
  it.each(["system", "tools", "memory", "goal"])("counts %s content before deciding whether history fits", async (source) => {
    const mainRequests: StreamMessageParams[] = [];
    const client: StreamingMessageClient = {
      async *streamMessage(params) {
        if (params.system === "You are a conversation summarizer.") {
          yield { type: "text_delta", delta: "Earlier work summarized." };
        } else {
          mainRequests.push(params);
        }
        yield { type: "complete", stopReason: "end_turn" };
      },
    };
    const largeContent = "guidance ".repeat(20_000);
    const registry = new ToolRegistry();
    if (source === "tools") registry.register({
      name: "Inspect", description: "Inspect a file", inputSchema: {
        type: "object", properties: { path: { type: "string", description: largeContent } },
      },
      execute: async () => ({ content: [] }),
    });
    const engine = new QueryEngine(client, registry, permissions, hooks, {
      compactKeepRecent: 4,
      trajectoryTrackerFactory: false,
      ...(source === "memory" ? { memoryRetriever: async () => largeContent } : {}),
      resolveRequestConfiguration: async () => ({
        revision: 1, model: "test", client, contextWindow: 100_000, maxOutputTokens: 20_000,
        systemPromptForTools: async () => source === "system" ? largeContent : "Work on the task.",
      }),
    });
    engine.loadMessages(history());
    const execution = {
      scope,
      ...(source === "goal" ? { contribution: { systemGuidance: largeContent } } : {}),
      emit: async () => {}, takeSteeredInputs: async () => [], closeSteering() {},
    } as unknown as AgentExecutionContext;
    await collect(engine, { execution });

    expect(mainRequests).toHaveLength(1);
    expect(mainRequests[0]!.messages.length).toBeLessThan(20);
    expect(mainRequests[0]!.messages.at(-1)).toMatchObject({ content: "Continue; preserve the source files." });
    expect(mainRequests[0]!.maxTokens).toBe(20_000);
  });

  it.each(["request", "stream"] as const)("recovers a %s overflow without repeating tools or consuming a turn", async (phase) => {
    const mainRequests: StreamMessageParams[] = [];
    const emitted: AgentEventInput[] = [];
    let summaries = 0;
    let executions = 0;
    const client: StreamingMessageClient = {
      async *streamMessage(params) {
        if (params.system === "You are a conversation summarizer.") {
          summaries++;
          yield { type: "text_delta", delta: "Earlier work summarized." };
          yield { type: "usage", usage: { inputTokens: 10, outputTokens: 2 } };
          yield { type: "complete", stopReason: "end_turn" };
          return;
        }
        mainRequests.push(params);
        if (mainRequests.length === 1) {
          if (phase === "stream") yield { type: "tool_use_start", toolUse: {
            type: "tool_use", id: "uncommitted-step", name: "Step", input: {},
          } };
          throw overflow(phase);
        }
        if (mainRequests.length === 2) {
          yield { type: "tool_use_start", toolUse: { type: "tool_use", id: "step", name: "Step", input: {} } };
          yield { type: "complete", stopReason: "tool_use" };
        } else {
          yield { type: "text_delta", delta: "Completed after compaction." };
          yield { type: "complete", stopReason: "end_turn" };
        }
      },
    };
    const registry = new ToolRegistry();
    registry.register({ name: "Step", description: "One step", inputSchema: {}, execute: async () => {
      executions++;
      return { content: [{ type: "text", text: "Step completed" }] };
    } });
    const engine = new QueryEngine(client, registry, permissions, hooks, {
      maxTurns: 2, compactKeepRecent: 4, trajectoryTrackerFactory: false,
      modelRetry: { maxTotalRetries: 0 },
      resolveRequestConfiguration: async () => ({
        revision: 1, model: "test", client, contextWindow: 1_048_576, maxOutputTokens: 65_536,
      }),
    });
    engine.loadMessages(history());
    const execution = {
      scope,
      emit: async (event: AgentEventInput) => { emitted.push(event); },
      takeSteeredInputs: async () => [], closeSteering() {},
    } as unknown as AgentExecutionContext;
    const events = await collect(engine, { execution });

    expect(summaries).toBe(1);
    expect(mainRequests).toHaveLength(3);
    expect(mainRequests[1]!.messages.length).toBeLessThan(mainRequests[0]!.messages.length);
    expect(mainRequests[1]!.maxTokens).toBe(65_536);
    expect(executions).toBe(1);
    expect(JSON.stringify(engine.getHistory())).not.toContain("uncommitted-step");
    expect(events.filter(event => event.type === "model_attempt_finished").map(event => event.status))
      .toEqual(["failed", "completed", "completed"]);
    expect(events.some(event => event.type === "text_delta" && event.delta === "Completed after compaction.")).toBe(true);
    expect(emitted).toContainEqual(expect.objectContaining({
      type: "domain.event", data: { name: "context_compaction", payload: expect.objectContaining({ trigger: "reactive", phase: "compact_end" }) },
    }));
    expect(emitted.filter(event => event.type === "model.attempt.started" && event.data.purpose === "compaction")).toHaveLength(1);
  });

  it("stops after one context recovery when the provider still rejects the smaller request", async () => {
    let requests = 0;
    let summaries = 0;
    const failure = overflow();
    const client: StreamingMessageClient = {
      async *streamMessage(params) {
        if (params.system === "You are a conversation summarizer.") {
          summaries++;
          yield { type: "text_delta", delta: "Earlier work summarized." };
          yield { type: "complete", stopReason: "end_turn" };
          return;
        }
        requests++;
        throw failure;
      },
    };
    const engine = new QueryEngine(client, new ToolRegistry(), permissions, hooks, { compactKeepRecent: 4 });
    engine.loadMessages(history());
    await expect(collect(engine)).rejects.toBe(failure);
    expect(requests).toBe(2);
    expect(summaries).toBe(1);
  });

  it("does not retry the same request when there is no history it can shorten", async () => {
    let requests = 0;
    const failure = overflow();
    const client: StreamingMessageClient = { async *streamMessage() { requests++; throw failure; } };
    const engine = new QueryEngine(client, new ToolRegistry(), permissions, hooks);
    await expect(collect(engine)).rejects.toBe(failure);
    expect(requests).toBe(1);
    expect(engine.getHistory()).toEqual([{ type: "user", content: "Continue; preserve the source files." }]);
  });

  it.each(["invalid_request", "authentication"] as const)("does not compact unrelated %s failures", async (kind) => {
    let requests = 0;
    const failure = new ModelRequestFailure(kind === "invalid_request" ? "Invalid tool schema" : "Invalid credentials for context window service", {
      kind, phase: "request", retryable: false, statusCode: kind === "authentication" ? 401 : 400,
    });
    const client: StreamingMessageClient = { async *streamMessage() { requests++; throw failure; } };
    const engine = new QueryEngine(client, new ToolRegistry(), permissions, hooks);
    engine.loadMessages(history());
    await expect(collect(engine)).rejects.toBe(failure);
    expect(requests).toBe(1);
  });

  it.each([
    "Tool schema exceeds configured limit",
    "Too many tokens in tool descriptions",
    "The context window parameter is unsupported",
    "Maximum context length must be a positive integer",
    "The context window parameter is unsupported; max_tokens exceeds model output limit",
    "max_tokens exceeds the output limit; context window is 200000",
    "Invalid schema for function 'context_length_exceeded': additionalProperties is required to be false.",
    "Invalid schema for function 'inspect': In context=('properties', 'input too long'), additionalProperties is required to be false.",
  ])("preserves history on a non-context limit error: %s", async (message) => {
    const requests: StreamMessageParams[] = [];
    const failure = new ModelRequestFailure(message, {
      kind: "invalid_request", phase: "request", retryable: false, statusCode: 400,
    });
    const client: StreamingMessageClient = {
      async *streamMessage(params) {
        requests.push(params);
        if (params.system === "You are a conversation summarizer.") {
          yield { type: "text_delta", delta: "Unnecessary summary" };
          yield { type: "complete", stopReason: "end_turn" };
          return;
        }
        throw failure;
      },
    };
    const engine = new QueryEngine(client, new ToolRegistry(), permissions, hooks, { compactKeepRecent: 4 });
    const original = history();
    engine.loadMessages(original);
    await expect(collect(engine)).rejects.toBe(failure);
    expect(requests).toHaveLength(1);
    expect(engine.getHistory()).toEqual([...original, { type: "user", content: "Continue; preserve the source files." }]);
  });

  it.each([
    { modelCap: 4096, profileCap: undefined, expected: 4096 },
    { modelCap: 4096, profileCap: 1024, expected: 1024 },
    { modelCap: undefined, profileCap: 2048, expected: 2048 },
    { modelCap: 100_000, profileCap: undefined, expected: 20_000 },
  ])("caps summary output at $expected for model=$modelCap profile=$profileCap", async ({ modelCap, profileCap, expected }) => {
    const summaries: StreamMessageParams[] = [];
    const client: StreamingMessageClient = {
      async *streamMessage(params) {
        if (params.system === "You are a conversation summarizer.") {
          summaries.push(params);
          if (params.maxTokens! > expected) throw new ModelRequestFailure("max_tokens exceeds model output limit", {
            kind: "invalid_request", phase: "request", retryable: false, statusCode: 400,
          });
          yield { type: "text_delta", delta: "Verified task progress retained." };
        }
        yield { type: "complete", stopReason: "end_turn" };
      },
    };
    const engine = new QueryEngine(client, new ToolRegistry(), permissions, hooks, {
      compactKeepRecent: 4,
      resolveRequestConfiguration: async () => ({
        revision: 1, model: "test", client, contextWindow: 48_000, maxOutputTokens: modelCap,
      }),
    });
    engine.loadMessages(history());
    await collect(engine, { execution: {
      scope, profile: { maxOutputTokens: profileCap },
      emit: async () => {}, takeSteeredInputs: async () => [], closeSteering() {},
    } as unknown as AgentExecutionContext });
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.maxTokens).toBe(expected);
    expect(engine.getHistory()).toContainEqual(expect.objectContaining({
      type: "assistant", compactRole: "summary", content: expect.stringContaining("Verified task progress retained."),
    }));
  });

  it.each(["unchanged", "setModel", "setApiClient", "configuration switch"])("refreshes the summary output cap before manual compaction after %s", async change => {
    const summaries: StreamMessageParams[] = [];
    let model = "test";
    let maxOutputTokens = 4096;
    const client: StreamingMessageClient = {
      async *streamMessage(params) {
        if (params.system === "You are a conversation summarizer.") {
          summaries.push(params);
          yield { type: "text_delta", delta: "Verified task progress retained." };
        }
        yield { type: "complete", stopReason: "end_turn" };
      },
    };
    const engine = new QueryEngine(client, new ToolRegistry(), permissions, hooks, {
      compactKeepRecent: 4,
      resolveRequestConfiguration: async () => ({ revision: 1, model, client, contextWindow: 48_000, maxOutputTokens }),
    });
    engine.loadMessages(history());
    await collect(engine);
    if (change === "setModel") engine.setModel("test");
    if (change === "setApiClient") engine.setApiClient(client);
    if (change === "configuration switch") { model = "smaller-model"; maxOutputTokens = 2048; }
    engine.loadMessages(history().map(message => ({ ...message, content: "x".repeat(6000) })));
    await engine.compact();
    expect(summaries.map(request => request.maxTokens)).toEqual([4096, change === "configuration switch" ? 2048 : 4096]);
    expect(summaries.at(-1)!.model).toBe(model);
  });

  it("honors the host limit before dispatching reactive compaction", async () => {
    let requests = 0;
    let checks = 0;
    const limit = new AgentExecutionLimitError("Goal budget exhausted");
    const client: StreamingMessageClient = { async *streamMessage() { requests++; throw overflow(); } };
    const engine = new QueryEngine(client, new ToolRegistry(), permissions, hooks, { compactKeepRecent: 4 });
    engine.loadMessages(history());
    const execution = {
      scope,
      limits: { check: async () => { if (++checks > 1) throw limit; } },
      emit: async () => {}, takeSteeredInputs: async () => [], closeSteering() {},
    } as unknown as AgentExecutionContext;
    await expect(collect(engine, { execution })).rejects.toBe(limit);
    expect(requests).toBe(1);
  });

  it("does not dispatch a recovered request after cancellation during summarization", async () => {
    const controller = new AbortController();
    const cancelled = new Error("User stopped the goal");
    let mainRequests = 0;
    const client: StreamingMessageClient = {
      async *streamMessage(params) {
        if (params.system === "You are a conversation summarizer.") {
          controller.abort(cancelled);
          throw cancelled;
        }
        mainRequests++;
        throw overflow();
      },
    };
    const engine = new QueryEngine(client, new ToolRegistry(), permissions, hooks, { compactKeepRecent: 4 });
    engine.loadMessages(history());
    await expect(collect(engine, { signal: controller.signal })).rejects.toBe(cancelled);
    expect(mainRequests).toBe(1);
  });
});

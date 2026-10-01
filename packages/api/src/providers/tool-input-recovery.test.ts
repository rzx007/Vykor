import { afterEach, describe, expect, it, vi } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { QueryEngine, ToolRegistry } from "@vykor/core";
import type { StreamEvent, ToolDefinition } from "@vykor/core";
import { OpenAICompatibleClient } from "./openai.js";
import { AnthropicClient } from "./anthropic.js";
import { CodexSubscriptionClient } from "./codex.js";

function openAIClient(
  respond: (params: any, request: number) => Array<{ name: string; arguments: string }>,
  finishReason: string | null = "tool_calls",
) {
  const client = new OpenAICompatibleClient({ apiKey: "test" });
  let request = 0;
  client.client = { chat: { completions: { create: async (params: any) => {
    const calls = respond(params, ++request);
    return { async *[Symbol.asyncIterator]() {
      if (!calls.length) yield { choices: [{ delta: { content: "Finished" }, finish_reason: null }] };
      for (const [index, call] of calls.entries()) {
        yield { choices: [{ delta: { tool_calls: [{
          index, id: `call_${request}_${index}`, type: "function", function: call,
        }] }, finish_reason: null }] };
      }
      yield { choices: [{ delta: {}, finish_reason: calls.length ? finishReason : "stop" }] };
    } };
  } } } } as any;
  return client;
}

const writeTool: ToolDefinition = {
  name: "Write",
  description: "Write a file",
  inputSchema: {
    type: "object",
    properties: { file_path: { type: "string" }, content: { type: "string" } },
    required: ["file_path", "content"],
  },
  execute: async () => ({ content: [{ type: "text", text: "Written" }] }),
};

async function collect(stream: AsyncIterable<StreamEvent>) {
  const events: StreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

afterEach(() => vi.unstubAllGlobals());

describe("native tool input recovery", () => {
  it.each(["broken", '{"content":"line\nbreak"}'])("handles invalid JSON through the real Anthropic SDK transport: %s", async (raw) => {
    const frames = [
      { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "test", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 2, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call_1", name: "Write", input: {} } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: raw } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 3 } },
      { type: "message_stop" },
    ];
    const client = new AnthropicClient({ apiKey: "test" });
    (client as any).client = new Anthropic({ apiKey: "test", maxRetries: 0, fetch: async () => new Response(
      frames.map((frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(""),
      { headers: { "content-type": "text/event-stream" } },
    ) });
    const events = await collect(client.streamMessage({ model: "test", messages: [], tools: [writeTool] }));
    expect(events.find((event) => event.type === "tool_use_start")).toMatchObject({
      toolUse: { inputError: { reason: "invalid_json" } },
    });
    expect(events.filter((event) => event.type === "usage").at(-1)).toMatchObject({
      usage: { inputTokens: 2, outputTokens: 3 },
    });
  });

  it("preserves Anthropic initial empty-object input when a tool has no argument deltas", async () => {
    const frames = [
      { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "test", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 2, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call_1", name: "List", input: {} } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 3 } },
      { type: "message_stop" },
    ];
    const client = new AnthropicClient({ apiKey: "test" });
    (client as any).client = new Anthropic({ apiKey: "test", maxRetries: 0, fetch: async () => new Response(
      frames.map((frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(""),
      { headers: { "content-type": "text/event-stream" } },
    ) });
    const events = await collect(client.streamMessage({ model: "test", messages: [] }));
    const call = events.find((event) => event.type === "tool_use_start");
    expect(call).toMatchObject({ toolUse: { name: "List", input: {} } });
    expect(call?.type === "tool_use_start" && call.toolUse.inputError).toBeUndefined();
  });

  it.each(["openai", "anthropic", "codex"])("%s returns malformed arguments as an explicitly invalid call", async (provider) => {
    const raw = '{"file_path":"index.html","content":"unfinished';
    let client: OpenAICompatibleClient | AnthropicClient | CodexSubscriptionClient;
    if (provider === "openai") {
      client = openAIClient(() => [{ name: "Write", arguments: raw }]);
    } else if (provider === "anthropic") {
      client = new AnthropicClient({ apiKey: "test" });
      (client as any).client = { messages: { create: () => ({
        async *[Symbol.asyncIterator]() {
          yield { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call_1", name: "Write" } };
          yield { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: raw } };
          yield { type: "content_block_stop", index: 0 };
          yield { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 3 } };
          yield { type: "message_stop" };
        },
      }) } };
    } else {
      const payload = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test" } })).toString("base64url");
      client = new CodexSubscriptionClient({ apiKey: `header.${payload}.sig` });
      vi.stubGlobal("fetch", async () => new Response([
        { type: "response.output_item.done", item: { type: "function_call", call_id: "call_1", name: "Write", arguments: raw } },
        { type: "response.completed" },
      ].map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")));
    }
    const events = await collect(client.streamMessage({ model: "test", messages: [], tools: [writeTool] }));
    const call = events.find((event) => event.type === "tool_use_start");
    expect(call?.type === "tool_use_start" && call.toolUse).toMatchObject({
      name: "Write", inputError: { reason: "invalid_json", argumentLength: raw.length },
    });
    expect(events.at(-1)).toMatchObject({ type: "complete", stopReason: "tool_use" });
  });

  it("lets the model correct malformed input and executes only the corrected call", async () => {
    const written: unknown[] = [];
    let feedback: any;
    const client = openAIClient((params, request) => {
      if (request === 1) return [{ name: "Write", arguments: '{"file_path":"index.html","content":' }];
      if (request === 2) {
        feedback = params.messages.find((message: any) => message.role === "tool");
        return [{ name: "Write", arguments: '{"file_path":"index.html","content":"<h1>Done</h1>"}' }];
      }
      return [];
    });
    const registry = new ToolRegistry();
    registry.register({ ...writeTool, execute: async (input) => {
      written.push(input);
      return { content: [{ type: "text", text: "Written" }] };
    } });
    const engine = new QueryEngine(client, registry,
      { checkTool: async () => ({ action: "allow" }) } as any,
      { execute: async () => ({ blocked: false }) } as any,
      { trajectoryTrackerFactory: false },
    );
    const events = await collect(engine.submitMessage("Build the page"));
    expect(written).toEqual([{ file_path: "index.html", content: "<h1>Done</h1>" }]);
    expect(feedback?.content).toContain("invalid_input");
    expect(feedback?.content).toContain("not_started");
    expect(events.filter((event) => event.type === "tool_use_end")).toMatchObject([
      { result: { isError: true, failureKind: "invalid_input", executionState: "not_started" } },
      { result: { executionState: "completed" } },
    ]);
    expect(engine.getHistory().at(-1)).toMatchObject({ type: "assistant", content: "Finished" });
  });

  it("never executes an invalid call even when its tool accepts an empty object", async () => {
    let executions = 0;
    let permissions = 0;
    const registry = new ToolRegistry();
    registry.register({ ...writeTool, inputSchema: { type: "object" }, execute: async () => {
      executions++;
      return { content: [] };
    } });
    const client = openAIClient((_params, request) => request === 1
      ? [{ name: "Write", arguments: "not JSON" }]
      : request === 2 ? [{ name: "Write", arguments: "{}" }] : []);
    const engine = new QueryEngine(client, registry,
      { checkTool: async () => { permissions++; return { action: "allow" }; } } as any,
      { execute: async () => ({ blocked: false }) } as any,
      { trajectoryTrackerFactory: false },
    );
    const events = await collect(engine.submitMessage("Run"));
    expect(executions).toBe(1);
    expect(permissions).toBe(1);
    expect(events.filter((event) => event.type === "tool_use_end")[0]).toMatchObject({
      result: { failureKind: "invalid_input", executionState: "not_started" },
    });
  });

  it.each([3, 50])("stops asking for tool calls after two failed corrections (maxTurns=%s)", async (maxTurns) => {
    let toolRequests = 0;
    let finalRequests = 0;
    const client = openAIClient((params) => {
      if (!params.tools?.length) { finalRequests++; return []; }
      toolRequests++;
      if (toolRequests > 5) return []; // Bound the regression on the old implementation.
      return [{ name: "Write", arguments: `broken ${toolRequests}` }];
    });
    const registry = new ToolRegistry();
    registry.register(writeTool);
    const engine = new QueryEngine(client, registry,
      { checkTool: async () => { throw new Error("Invalid input must not ask for permission"); } } as any,
      { execute: async () => ({ blocked: false }) } as any,
      { trajectoryTrackerFactory: false, maxTurns },
    );
    const events = await collect(engine.submitMessage("Build the page"));
    expect(toolRequests).toBe(3);
    expect(finalRequests).toBe(1);
    expect(events.filter((event) => event.type === "tool_use_end")).toHaveLength(3);
  });

  it("keeps a valid sibling tool call when another call has malformed arguments", async () => {
    const client = openAIClient(() => [
      { name: "Write", arguments: "broken" },
      { name: "Read", arguments: '{"file_path":"existing.txt"}' },
    ]);
    const events = await collect(client.streamMessage({ model: "test", messages: [], tools: [writeTool] }));
    expect(events.filter((event) => event.type === "tool_use_start")).toMatchObject([
      { toolUse: { name: "Write", inputError: { reason: "invalid_json" } } },
      { toolUse: { name: "Read", input: { file_path: "existing.txt" } } },
    ]);
  });

  it.each(["[]", "null", "42", '"text"'])("does not turn %s into a valid empty tool input", async (raw) => {
    const client = openAIClient(() => [{ name: "Write", arguments: raw }]);
    const events = await collect(client.streamMessage({ model: "test", messages: [], tools: [writeTool] }));
    expect(events.find((event) => event.type === "tool_use_start")).toMatchObject({
      toolUse: { inputError: { reason: "invalid_shape" } },
    });
  });

  it("does not treat an empty argument stream as a valid call to a tool with no required fields", async () => {
    let executions = 0;
    const registry = new ToolRegistry();
    registry.register({ ...writeTool, inputSchema: { type: "object" }, execute: async () => {
      executions++;
      return { content: [] };
    } });
    const client = openAIClient((_params, request) => request === 1
      ? [{ name: "Write", arguments: "" }] : []);
    const engine = new QueryEngine(client, registry,
      { checkTool: async () => ({ action: "allow" }) } as any,
      { execute: async () => ({ blocked: false }) } as any,
      { trajectoryTrackerFactory: false },
    );
    const events = await collect(engine.submitMessage("Run"));
    expect(executions).toBe(0);
    expect(events.find((event) => event.type === "tool_use_end")).toMatchObject({
      result: { failureKind: "invalid_input", executionState: "not_started" },
    });
  });

  it("retains output-limit diagnostics without exposing raw tool content", async () => {
    const raw = '{"content":"PRIVATE-CONTENT';
    const client = openAIClient(() => [{ name: "Write", arguments: raw }], "length");
    const events = await collect(client.streamMessage({ model: "test", messages: [], tools: [writeTool] }));
    const call = events.find((event) => event.type === "tool_use_start");
    expect(call).toMatchObject({ toolUse: { inputError: { stopReason: "length", argumentLength: raw.length } } });
    expect(JSON.stringify(call)).not.toContain("PRIVATE-CONTENT");
  });

  it("does not recover a malformed call from a stream without a finish marker", async () => {
    const client = openAIClient(() => [{ name: "Write", arguments: "broken" }], null);
    await expect(collect(client.streamMessage({ model: "test", messages: [], tools: [writeTool] })))
      .rejects.toMatchObject({ info: { kind: "stream_incomplete", retryable: true } });
  });

  it("still checks permissions after the model corrects its arguments", async () => {
    let executions = 0;
    const registry = new ToolRegistry();
    registry.register({ ...writeTool, execute: async () => { executions++; return { content: [] }; } });
    const client = openAIClient((_params, request) => request === 1
      ? [{ name: "Write", arguments: "broken" }]
      : request === 2 ? [{ name: "Write", arguments: '{"file_path":"blocked.txt","content":"data"}' }] : []);
    const engine = new QueryEngine(client, registry,
      { checkTool: async () => ({ action: "deny", reason: "blocked" }) } as any,
      { execute: async () => ({ blocked: false }) } as any,
      { trajectoryTrackerFactory: false },
    );
    const events = await collect(engine.submitMessage("Write"));
    expect(executions).toBe(0);
    expect(events.filter((event) => event.type === "tool_use_end")).toMatchObject([
      { result: { failureKind: "invalid_input", executionState: "not_started" } },
      { result: { failureKind: "permission", executionState: "not_started" } },
    ]);
  });

  it("does not execute tools if the model ignores the finalization after failed corrections", async () => {
    let executions = 0;
    const registry = new ToolRegistry();
    registry.register({ ...writeTool, execute: async () => { executions++; return { content: [] }; } });
    const client = openAIClient((params) => [{ name: "Write", arguments: params.tools?.length
      ? "broken" : '{"file_path":"unexpected.txt","content":"data"}' }]);
    const engine = new QueryEngine(client, registry,
      { checkTool: async () => ({ action: "allow" }) } as any,
      { execute: async () => ({ blocked: false }) } as any,
      { trajectoryTrackerFactory: false },
    );
    await expect(collect(engine.submitMessage("Write"))).rejects.toThrow();
    expect(executions).toBe(0);
  });
});

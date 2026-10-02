import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAICompatibleClient } from "./openai.js";
import { AnthropicClient } from "./anthropic.js";
import { CodexSubscriptionClient } from "./codex.js";
import type { StreamEvent } from "@vykor/core";

afterEach(() => vi.unstubAllGlobals());

async function collect(stream: AsyncIterable<StreamEvent>) {
  const events: StreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("display-only tool argument progress", () => {
  it("reports interleaved OpenAI calls and late IDs without sending parameter text", async () => {
    const client = new OpenAICompatibleClient({ apiKey: "test" });
    client.client = { chat: { completions: { create: async () => ({ async *[Symbol.asyncIterator]() {
      yield { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "Write", arguments: '{"body":' } }] } }] };
      yield { choices: [{ delta: { tool_calls: [{ index: 1, id: "second", function: { name: "Read", arguments: "{}" } }] } }] };
      yield { choices: [{ delta: { tool_calls: [{ index: 0, id: "first", function: { arguments: '"private generated body"}' } }] } }] };
      yield { choices: [{ delta: {}, finish_reason: "tool_calls" }] };
    } }) } } } as any;
    const events = await collect(client.streamMessage({ model: "test", messages: [] }));
    const progress = events.filter(e => e.type === "tool_generation_progress");
    expect(progress).toMatchObject([
      { toolKey: "0", toolName: "Write", receivedChars: 8 },
      { toolKey: "1", toolUseId: "second", receivedChars: 2 },
      { toolKey: "0", toolUseId: "first", receivedChars: 33 },
    ]);
    expect(JSON.stringify(progress)).not.toContain("private generated body");
    expect(events.findIndex(e => e.type === "tool_use_start")).toBeGreaterThan(events.indexOf(progress.at(-1)!));
  });

  it("reports Anthropic block start and raw argument lengths", async () => {
    const client = new AnthropicClient({ apiKey: "test" });
    (client as any).client = { messages: { create: () => ({ withResponse: async () => ({ response: { headers: {} }, data: {
      async *[Symbol.asyncIterator]() {
        yield { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "first", name: "Write", input: {} } };
        yield { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: "broken" } };
        yield { type: "content_block_stop", index: 2 };
        yield { type: "message_stop" };
      },
    } }) }) } };
    const events = await collect(client.streamMessage({ model: "test", messages: [] }));
    expect(events.filter(e => e.type === "tool_generation_progress")).toMatchObject([
      { toolKey: "2", toolUseId: "first", toolName: "Write", receivedChars: 0 },
      { toolKey: "2", receivedChars: 6 },
    ]);
    expect(events.find(e => e.type === "tool_use_start")).toMatchObject({ toolUse: { inputError: { reason: "invalid_json" } } });
  });

  it("reports Codex function argument deltas while committing only the done item", async () => {
    const token = `a.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test" } })).toString("base64url")}.c`;
    const frames = [
      { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "item", call_id: "first", name: "Write", arguments: "" } },
      { type: "response.function_call_arguments.delta", item_id: "item", output_index: 0, delta: '{"v":' },
      { type: "response.function_call_arguments.delta", item_id: "item", output_index: 0, delta: "1}" },
      { type: "response.output_item.done", item: { type: "function_call", id: "item", call_id: "first", name: "Write", arguments: '{"v":1}' } },
      { type: "response.completed", response: {} },
    ];
    vi.stubGlobal("fetch", async () => new Response(frames.map(e => `data: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } }));
    const events = await collect(new CodexSubscriptionClient({ apiKey: token }).streamMessage({ model: "test", messages: [] }));
    expect(events.filter(e => e.type === "tool_generation_progress")).toMatchObject([
      { toolKey: "item", toolUseId: "first", toolName: "Write", receivedChars: 0 },
      { toolKey: "item", receivedChars: 5 },
      { toolKey: "item", receivedChars: 7 },
    ]);
    expect(events.filter(e => e.type === "tool_use_start")).toHaveLength(1);
  });
});

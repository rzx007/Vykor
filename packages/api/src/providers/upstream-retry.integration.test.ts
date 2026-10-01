import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { QueryEngine, ToolRegistry } from "@vykor/core";
import type { StreamEvent } from "@vykor/core";
import { OpenAICompatibleClient } from "./openai.js";
import { AnthropicClient } from "./anthropic.js";

const terminated = "Upstream stream terminated unexpectedly before completion";
const noDelay = { baseDelayMs: 0, maxDelayMs: 0 };

function response(frames: unknown[], headers: Record<string, string> = {}) {
  return new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream", ...headers },
  });
}

function toolCall(id: string, value: string) {
  return { choices: [{ delta: { tool_calls: [{ index: 0, id, type: "function", function: {
    name: "Write", arguments: JSON.stringify({ value }),
  } }] }, finish_reason: null }] };
}

function engine(client: OpenAICompatibleClient, registry = new ToolRegistry()) {
  return new QueryEngine(client, registry,
    { checkTool: async () => ({ action: "allow" }) } as any,
    { execute: async () => ({ blocked: false }) } as any,
    { trajectoryTrackerFactory: false, modelRetry: noDelay },
  );
}

async function collect(stream: AsyncIterable<StreamEvent>) {
  const events: StreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("upstream stream recovery through the real SDK", () => {
  it("regenerates only the failed turn and executes each completed tool action once", async () => {
    const requests: any[] = [];
    const client = new OpenAICompatibleClient({ apiKey: "test" });
    client.client = new OpenAI({ apiKey: "test", maxRetries: 0, fetch: async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      switch (requests.length) {
        case 1: return response([toolCall("first", "first"), { choices: [{ delta: {}, finish_reason: "tool_calls" }] }]);
        case 2: return response([
          { choices: [{ delta: { content: "partial output must be discarded" }, finish_reason: null }] },
          toolCall("partial", "must not execute"), { error: { message: terminated } },
        ]);
        case 3: return response([toolCall("second", "second"), { choices: [{ delta: {}, finish_reason: "tool_calls" }] }]);
        default: return response([{ choices: [{ delta: { content: "Done" }, finish_reason: "stop" }] }]);
      }
    } });
    const writes: string[] = [];
    const registry = new ToolRegistry();
    registry.register({ name: "Write", description: "record action", inputSchema: { type: "object" },
      execute: async (input) => { writes.push(input.value as string); return { content: [{ type: "text", text: "written" }] }; },
    });
    const query = engine(client, registry);
    const events = await collect(query.submitMessage("write two values"));
    expect(writes).toEqual(["first", "second"]);
    expect(requests).toHaveLength(4);
    expect(requests[2].messages).toEqual(requests[1].messages);
    expect(events.filter((event) => event.type === "model_retry")).toMatchObject([
      { reason: "stream_incomplete", retryNumber: 1 },
    ]);
    expect(query.getHistory().filter((message) => message.type === "assistant").map((message) => message.content))
      .not.toContain("partial output must be discarded");
    expect(events.filter((event) => event.type === "model_attempt_finished").map((event) => event.status))
      .toEqual(["completed", "failed", "completed", "completed"]);
  });

  it("stops after the stream retry limit when the upstream keeps disconnecting", async () => {
    let requests = 0;
    const client = new OpenAICompatibleClient({ apiKey: "test" });
    client.client = new OpenAI({ apiKey: "test", maxRetries: 0, fetch: async () => {
      requests++;
      return response([{ error: { message: terminated } }]);
    } });
    await expect(collect(engine(client).submitMessage("start")))
      .rejects.toMatchObject({ info: { kind: "stream_incomplete", retryable: true } });
    expect(requests).toBe(4);
  });

  it("classifies a real Anthropic mid-stream overloaded event as retryable", async () => {
    const client = new AnthropicClient({ apiKey: "test" });
    (client as any).client = new Anthropic({ apiKey: "test", maxRetries: 0, fetch: async () => new Response(
      'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n',
      { headers: { "content-type": "text/event-stream", "retry-after": "4", "request-id": "req-anthropic-stream" } },
    ) });
    await expect(collect(client.streamMessage({ model: "test", messages: [] })))
      .rejects.toMatchObject({ info: {
        kind: "server", phase: "stream", retryable: true, retryAfterMs: 4_000, requestId: "req-anthropic-stream",
      } });
  });

  it("does not start another attempt when the user cancels during recovery", async () => {
    let requests = 0;
    const controller = new AbortController();
    const stopped = new Error("user stopped");
    const client = new OpenAICompatibleClient({ apiKey: "test" });
    client.client = new OpenAI({ apiKey: "test", maxRetries: 0, fetch: async () => {
      requests++;
      return response([{ error: { message: terminated } }]);
    } });
    await expect((async () => {
      for await (const event of engine(client).submitMessage("start", { signal: controller.signal })) {
        if (event.type === "model_retry") controller.abort(stopped);
      }
    })()).rejects.toBe(stopped);
    expect(requests).toBe(1);
  });

  it("does not shorten Retry-After to fit the recovery deadline", async () => {
    let requests = 0;
    const client = new OpenAICompatibleClient({ apiKey: "test" });
    client.client = new OpenAI({ apiKey: "test", maxRetries: 0, fetch: async () => {
      requests++;
      return response([{ error: { code: "rate_limit_exceeded", message: "slow down" } }], { "retry-after": "10" });
    } });
    const query = new QueryEngine(client, new ToolRegistry(),
      { checkTool: async () => ({ action: "allow" }) } as any,
      { execute: async () => ({ blocked: false }) } as any,
      { trajectoryTrackerFactory: false, modelRetry: { ...noDelay, recoveryBudgetMs: 1_000 } },
    );
    await expect(collect(query.submitMessage("start"))).rejects.toMatchObject({
      info: { kind: "rate_limit", retryable: true, retryAfterMs: 10_000 },
    });
    expect(requests).toBe(1);
  });
});

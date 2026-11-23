import { inspect } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import type { StreamMessageParams } from "@vykor/agent-contracts";
import { AnthropicClient } from "../anthropic.js";
import { OpenAICompatibleClient } from "../openai.js";

const image = "cHJpdmF0ZS1jYXB0dXJlLXN5bnRoZXRpYy1maXh0dXJl";
const params: StreamMessageParams = {
  model: "test",
  messages: [{ type: "user", content: [{ type: "image", source: {
    type: "memory", data: image, mediaType: "image/png", width: 1, height: 1,
  } }] }],
  isEphemeralImageCurrent: () => true,
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it.each([
  { name: "OpenAI", Provider: OpenAICompatibleClient, path: "/v1/chat/completions",
    stream: 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\r\n\r\ndata: [DONE]\r\n\r\n' },
  { name: "Anthropic", Provider: AnthropicClient, path: "/v1/messages",
    stream: 'event: message_stop\r\ndata: {"type":"message_stop"}\r\n\r\n' },
])("sends a capture without logging its request or response bodies in $name", async ({ Provider, path, stream }) => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubEnv("DEBUG", "true");
  const provider = new Provider({ apiKey: "test", baseURL: "https://offline.invalid" + (Provider === OpenAICompatibleClient ? "/v1" : "") });
  const sdk: object = Reflect.get(provider, "client");
  const fetch = vi.fn((_url: string, _init: { body: string }) => Promise.resolve(new Response(stream, {
    headers: { "content-type": "text/event-stream" },
  })));
  Object.assign(sdk, { fetch });

  const collect = async () => {
    const events = [];
    for await (const event of provider.streamMessage(params)) events.push(event);
    return events;
  };
  await expect(collect()).resolves.toContainEqual(expect.objectContaining({ type: "complete" }));
  expect(fetch).toHaveBeenCalledOnce();
  expect(new URL(fetch.mock.calls[0]![0]).pathname).toBe(path);
  expect(fetch.mock.calls[0]![1].body).toContain(image);
  expect(inspect(log.mock.calls, { depth: null }).includes(image)).toBe(false);

  fetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: image, code: "context_length_exceeded" } }), {
    status: 400,
    headers: { "content-type": "application/json", "x-upstream-echo": image },
  }));
  await expect(collect()).rejects.toMatchObject({ info: { kind: "invalid_request", contextLengthExceeded: true } });

  fetch.mockResolvedValueOnce(new Response(`event: ${Provider === AnthropicClient ? "content_block_delta" : "error"}\ndata: ${image}\n\n`, {
    headers: { "content-type": "text/event-stream" },
  }));
  await expect(collect()).rejects.toThrow();
  expect(inspect([log.mock.calls, errorLog.mock.calls], { depth: null }).includes(image)).toBe(false);
  expect(process.env.DEBUG).toBe("true");
});

import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAICompatibleClient, CodexSubscriptionClient } from "@vykor/api";
import { assertSanitized, createHttpReplay, requireRecording, type HttpRecording, type RecordingRoute } from "../../packages/api/src/providers/recordings/http-recording.js";

const fixtures = new URL("../../packages/api/src/providers/recordings/__test__/fixtures/", import.meta.url);
const echo = { name: "Echo", description: "Return the public probe", inputSchema: { type: "object", properties: {
  value: { type: "string" },
}, required: ["value"], additionalProperties: false }, execute: async () => ({ content: [] }) };
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

// Split bytes, not characters: a width of 1 also exercises incremental UTF-8 decoding.
function fragment(fetch: typeof globalThis.fetch): typeof globalThis.fetch {
  return async (input, init) => {
    const response = await fetch(input, init);
    const bytes = new Uint8Array(await response.arrayBuffer());
    let position = 0;
    return new Response(new ReadableStream<Uint8Array>({ pull(controller) {
      if (position < bytes.length) controller.enqueue(bytes.subarray(position, ++position));
      else controller.close();
    } }), { status: response.status, headers: response.headers });
  };
}

async function fixture(route: RecordingRoute): Promise<HttpRecording> {
  const manifest = JSON.parse(await readFile(new URL("manifest.json", fixtures), "utf8"));
  expect(manifest.requiredRoutes).toEqual(["openai", "codex"]);
  const entry = manifest.recordings.find((item: { route: string }) => item.route === route);
  if (!entry) throw new Error(`Missing required observed recording: ${route}`);
  const raw = await readFile(new URL(entry.file, fixtures), "utf8");
  expect(createHash("sha256").update(raw).digest("hex")).toBe(entry.sha256);
  const recording = requireRecording([JSON.parse(raw)], route);
  assertSanitized(recording);
  expect(recording.source.capturedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
  return recording;
}

describe("observed provider HTTP replay through real decoders", () => {
  it("replays real OpenAI tool arguments, stop and usage twice without credentials or network", async () => {
    const recording = await fixture("openai");
    vi.stubGlobal("fetch", () => { throw new Error("Network prohibited during offline replay"); });
    const runs = [];
    for (let repeat = 0; repeat < 2; repeat++) {
      const replay = createHttpReplay([recording]);
      const client = new OpenAICompatibleClient({ apiKey: "offline-placeholder", baseURL: "https://offline.invalid/v1" });
      vi.spyOn(client.client as unknown as { fetch: typeof fetch }, "fetch").mockImplementation(repeat ? fragment(replay.fetch) : replay.fetch);
      const events = [];
      for await (const event of client.streamMessage({ model: "mimo-v2.5:free", maxTokens: 128,
        messages: [{ type: "user", content: "Call Echo once with value public-probe. Do not write prose." }], tools: [echo] })) events.push(event);
      replay.assertConsumed();
      expect(events.find(event => event.type === "tool_use_start")).toMatchObject({ toolUse: { name: "Echo", input: { value: "public-probe" } } });
      expect(events.find(event => event.type === "usage")).toMatchObject({ usage: { inputTokens: 98, outputTokens: 21 } });
      expect(events.at(-1)).toMatchObject({ type: "complete", stopReason: "tool_use" });
      runs.push(events);
    }
    expect(runs[1]).toEqual(runs[0]);
  });

  it("replays real Codex text, unknown event and token usage twice through the HTTP SSE decoder", async () => {
    const recording = await fixture("codex");
    expect(recording.response.chunks.join("")).toContain('"type":"response.metadata"');
    const runs = [];
    for (let repeat = 0; repeat < 2; repeat++) {
      const replay = createHttpReplay([recording]);
      vi.stubGlobal("fetch", repeat ? fragment(replay.fetch) : replay.fetch);
      const payload = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "offline" } })).toString("base64url");
      const client = new CodexSubscriptionClient({ apiKey: `offline.${payload}.unsigned` });
      const events = [];
      for await (const event of client.streamMessage({ model: "gpt-5.6-sol", messages: [{ type: "user", content: "Return exactly public-probe. No reasoning or explanation." }] })) events.push(event);
      replay.assertConsumed();
      expect(events.filter(event => event.type === "text_delta").map(event => event.type === "text_delta" ? event.delta : "").join("")).toBe("public-probe");
      expect(events.find(event => event.type === "usage")).toMatchObject({ usage: { inputTokens: 27, outputTokens: 7 } });
      expect(events.at(-1)).toMatchObject({ type: "complete", stopReason: "stop" });
      runs.push(events);
    }
    expect(runs[1]).toEqual(runs[0]);
  });

  it("decodes synthetic non-ASCII text across individual UTF-8 bytes without calling it observed", async () => {
    const recording: HttpRecording = {
      version: 1, route: "openai", source: { kind: "synthetic", description: "UTF-8 transport edge case, not observed" },
      request: { method: "POST", path: "/v1/chat/completions", body: { model: "m", messages: [], max_tokens: 1, stream: true, stream_options: { include_usage: true } } },
      response: { status: 200, headers: { "content-type": "text/event-stream" }, chunks: [
        'data: {"choices":[{"index":0,"delta":{"content":"你好"},"finish_reason":null}]}\n\n',
        'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      ] },
    };
    vi.stubGlobal("fetch", () => { throw new Error("Network prohibited"); });
    const replay = createHttpReplay([recording]);
    const client = new OpenAICompatibleClient({ apiKey: "offline-placeholder", baseURL: "https://offline.invalid/v1" });
    vi.spyOn(client.client as unknown as { fetch: typeof fetch }, "fetch").mockImplementation(fragment(replay.fetch));
    const text = [];
    for await (const event of client.streamMessage({ model: "m", maxTokens: 1, messages: [] })) if (event.type === "text_delta") text.push(event.delta);
    expect(text.join("")).toBe("你好");
    replay.assertConsumed();
  });
});

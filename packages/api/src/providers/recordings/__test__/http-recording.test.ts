import { describe, expect, it } from "vitest";
import { captureHttpExchange, createHttpReplay, requireRecording, assertSanitized, sanitizeRecording } from "../http-recording.js";

// Constructed transport data tests the recorder itself. It is never an observed provider fixture.
const exchange = () => ({
  version: 1 as const, route: "openai" as const, source: { kind: "synthetic" as const, description: "recorder unit test" },
  request: { method: "POST", path: "/v1/chat/completions", body: { model: "m", messages: [{ role: "user", content: "public" }] } },
  response: { status: 200, headers: { "content-type": "text/event-stream" },
    chunks: ['data: {"choices":[{"delta":{"content":"hello"},"finish_reason":null}]}\n\n', 'data: [DONE]\n\n'] },
});

describe("HTTP recordings", () => {
  it("captures the actual response bytes and request without persisting credentials or hosts", async () => {
    const recording = await captureHttpExchange(async () => new Response("data: observed\n\n", {
      headers: { "content-type": "text/event-stream", "set-cookie": "private-cookie" },
    }), "https://private.example/v1/chat/completions", {
      method: "POST", headers: { Authorization: "Bearer private-key" }, body: JSON.stringify({ model: "m" }),
    }, { route: "openai", description: "controlled provider observation", redactions: [] });
    expect(recording.source.kind).toBe("observed");
    expect(recording.request).toEqual({ method: "POST", path: "/v1/chat/completions", body: { model: "m" } });
    expect(recording.response.chunks.join("")).toBe("data: observed\n\n");
    expect(JSON.stringify(recording)).not.toMatch(/private-(?:cookie|key)|private\.example/);
  });

  it("aborts an oversized observation before retaining an unbounded response", async () => {
    await expect(captureHttpExchange(async () => new Response("12345"), "https://offline.invalid/probe", {}, {
      route: "openai", description: "size-limit test", redactions: [], maxResponseBytes: 4,
    })).rejects.toThrow(/response byte budget/i);
  });

  it("redacts known private content and fragmented secrets without changing tool or unknown event structure", () => {
    const original = exchange();
    original.response.chunks = ['data: {"type":"future.event","tool":{"arguments":"{\\"path\\":\\"C:/Users/alice/note\\",\\"count\\":2}"},"usage":{"output_tokens":7},"text":"sec', 'ret-value"}\n\n'];
    const safe = sanitizeRecording(original, ["secret-value", "C:/Users/alice/note"]);
    expect(JSON.parse(safe.response.chunks.join("").slice(6))).toEqual({ type: "future.event", tool: {
      arguments: '{"path":"[REDACTED]","count":2}',
    }, usage: { output_tokens: 7 }, text: "[REDACTED]" });
    expect(original.response.chunks.join("")).toContain("secret-value");
  });

  it("rejects credential fields, tokens and personal paths left in a fixture", () => {
    for (const value of ["Bearer abcdefghijklmnopqrstuv", "sk-abcdefghijklmnopqrstuv", "C:\\Users\\alice\\note", "/home/alice/note"]) {
      expect(() => assertSanitized({ value })).toThrow(/unsafe recording/i);
    }
    expect(() => assertSanitized({ authorization: "a-secret" })).toThrow(/unsafe recording/i);
    expect(() => assertSanitized({ text: "[REDACTED]" })).not.toThrow();
    expect(() => assertSanitized({ chunks: ['data: {"future":{"access_token":"nonstandard-secret"}}\n\n'] })).toThrow(/unsafe recording/i);
    expect(() => assertSanitized({ chunks: ['data: {"future":{"access_', 'token":"nonstandard-secret"}}\n\n'] })).toThrow(/unsafe recording/i);
  });

  it("rejects sensitive SSE fields after event or comment prefixes, including during capture", async () => {
    const wire = ': keepalive\r\nevent: future.event\r\ndata: {"future":{"access_token":"synthetic-secret"}}\r\n\r\n';
    expect(() => assertSanitized(wire)).toThrow(/unsafe recording/i);
    await expect(captureHttpExchange(async () => new Response(wire), "https://offline.invalid/probe", {}, {
      route: "codex", description: "synthetic prefix regression", redactions: [],
    })).rejects.toThrow(/unsafe recording/i);
  });

  it("joins multiline SSE data before checking encrypted fields and whitespace-prefixed JSON", () => {
    const wire = 'event: future.event\ndata: {\ndata: "future":{"encrypted_content":"synthetic-secret"}\ndata: }\n\n';
    expect(() => assertSanitized(wire)).toThrow(/unsafe recording/i);
    expect(() => assertSanitized(' \n {"arguments":" \\n {\\"access_token\\":\\"synthetic-secret\\"}"}')).toThrow(/unsafe recording/i);
  });

  it("checks prefixed multiline events across chunks while preserving explicitly redacted wire shapes", () => {
    const original = exchange();
    original.response.chunks = [': keepalive\r\nevent: future.event\r\ndata: {\r\ndata: "access_', 'token":"synthetic-secret", "unknown":{"count":2}\r\ndata: }\r\n\r\n'];
    expect(() => assertSanitized(original)).toThrow(/unsafe recording/i);
    const safe = sanitizeRecording(original, ["synthetic-secret"]);
    expect(safe.response.chunks.join("")).toBe(': keepalive\r\nevent: future.event\r\ndata: {\r\ndata: "access_token":"[REDACTED]", "unknown":{"count":2}\r\ndata: }\r\n\r\n');
    expect(() => assertSanitized(safe)).not.toThrow();
  });

  it("redacts JSON-escaped Windows paths in tool argument strings", () => {
    const original = exchange();
    original.response.chunks = [`data: ${JSON.stringify({ arguments: JSON.stringify({ path: "C:\\Users\\alice\\note", count: 2 }) })}\n\n`];
    const safe = sanitizeRecording(original, ["C:\\Users\\alice\\note"]);
    expect(JSON.parse(JSON.parse(safe.response.chunks.join("").slice(6)).arguments)).toEqual({ path: "[REDACTED]", count: 2 });
  });

  it("replays deterministically, compares request bodies and fails closed on extra requests", async () => {
    for (let repeat = 0; repeat < 2; repeat++) {
      const replay = createHttpReplay([exchange()]);
      await expect(replay.fetch("https://offline.invalid/wrong", { method: "POST", body: "{}" })).rejects.toThrow(/request mismatch/i);
      const response = await replay.fetch("https://offline.invalid/v1/chat/completions", {
        method: "POST", body: JSON.stringify({ messages: [{ content: "public", role: "user" }], model: "m" }),
      });
      expect(await response.text()).toBe(exchange().response.chunks.join(""));
      replay.assertConsumed();
      await expect(replay.fetch("https://offline.invalid/extra")).rejects.toThrow(/unexpected request/i);
    }
    expect(() => createHttpReplay([exchange()]).assertConsumed()).toThrow(/unconsumed/i);
  });

  it("fails required observed routes when recordings are absent or synthetic", () => {
    expect(() => requireRecording([], "anthropic")).toThrow(/missing required observed recording.*anthropic/i);
    expect(() => requireRecording([exchange()], "openai")).toThrow(/missing required observed recording.*openai/i);
  });
});

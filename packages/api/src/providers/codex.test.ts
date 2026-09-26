import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildCodexHeaders, CodexSubscriptionClient, resolveCodexUrl } from "./codex";

function jwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.sig`;
}

describe("resolveCodexUrl", () => {
  it("defaults to chatgpt codex responses", () => {
    expect(resolveCodexUrl()).toBe("https://chatgpt.com/backend-api/codex/responses");
  });

  it("normalizes backend-api and codex URLs", () => {
    expect(resolveCodexUrl("https://chatgpt.com/backend-api")).toBe(
      "https://chatgpt.com/backend-api/codex/responses",
    );
    expect(resolveCodexUrl("https://chatgpt.com/backend-api/codex")).toBe(
      "https://chatgpt.com/backend-api/codex/responses",
    );
  });
});

describe("buildCodexHeaders", () => {
  it("extracts chatgpt account id from the access token", () => {
    const token = jwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "acct_123" },
    });
    const headers = buildCodexHeaders(token);
    expect(headers.Authorization).toBe(`Bearer ${token}`);
    expect(headers["chatgpt-account-id"]).toBe("acct_123");
  });
});

describe("CodexSubscriptionClient phases", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("streams commentary phases and preserves them when replaying assistant messages", async () => {
    const token = jwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "acct_123" },
    });
    let requestBody: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const frames = [
        { type: "response.output_item.added", item: { id: "msg_1", type: "message", phase: "commentary" } },
        { type: "response.output_text.delta", item_id: "msg_1", delta: "Checking the build." },
        { type: "response.completed", response: { usage: { input_tokens: 2, output_tokens: 3 } } },
      ];
      return new Response(
        frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(""),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }));

    const client = new CodexSubscriptionClient({ apiKey: token });
    const events = [];
    for await (const event of client.streamMessage({
      model: "gpt-test",
      system: "system",
      messages: [{ type: "assistant", content: "Starting.", phase: "commentary" }],
    })) {
      events.push(event);
    }

    expect(events[0]).toEqual({
      type: "text_delta",
      delta: "Checking the build.",
      phase: "commentary",
    });
    expect(requestBody?.input).toEqual([expect.objectContaining({
      type: "message",
      role: "assistant",
      phase: "commentary",
    })]);
  });
});

describe("CodexSubscriptionClient stream completion validation", () => {
  afterEach(() => vi.unstubAllGlobals());

  function sse(frames: Array<Record<string, unknown>>): Response {
    return new Response(
      frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(""),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  }

  function clientWith(response: () => Response) {
    vi.stubGlobal("fetch", vi.fn(async () => response()));
    return new CodexSubscriptionClient({
      apiKey: jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_123" } }),
    });
  }

  async function collect(client: CodexSubscriptionClient) {
    const events: any[] = [];
    for await (const event of client.streamMessage({
      model: "gpt-test",
      messages: [{ type: "user", content: "hi" }],
    })) {
      events.push(event);
    }
    return events;
  }

  it("preserves structured quota and retry headers on HTTP errors", async () => {
    const quota = clientWith(() => new Response(JSON.stringify({
      error: { code: "insufficient_quota", message: "quota exhausted" },
    }), { status: 429, headers: { "retry-after": "20", "x-request-id": "req-quota" } }));
    await expect(collect(quota)).rejects.toMatchObject({
      info: { kind: "quota", retryable: false, statusCode: 429, requestId: "req-quota" },
    });
    const limited = clientWith(() => new Response(JSON.stringify({
      error: { code: "rate_limit_exceeded", message: "slow down" },
    }), { status: 429, headers: { "retry-after": "20", "x-request-id": "req-rate" } }));
    await expect(collect(limited)).rejects.toMatchObject({
      info: { kind: "rate_limit", retryable: true, statusCode: 429, retryAfterMs: 20_000,
        requestId: "req-rate" },
    });
  });

  it("does not invent usage, and retains a snapshot before a protocol error", async () => {
    const unknown = clientWith(() => sse([{ type: "response.completed", response: {} }]));
    expect((await collect(unknown)).filter((event) => event.type === "usage")).toEqual([]);

    const partial = clientWith(() => sse([
      { type: "response.in_progress", response: { usage: { input_tokens: 7, output_tokens: 2 } } },
      { type: "response.failed", error: { code: "invalid_request", message: "bad" } },
    ]));
    const usages: any[] = [];
    await expect((async () => {
      for await (const event of partial.streamMessage({ model: "gpt-test", messages: [{ type: "user", content: "hi" }] })) {
        if (event.type === "usage") usages.push(event.usage);
      }
    })()).rejects.toMatchObject({ name: "ModelRequestFailure" });
    expect(usages).toEqual([{ inputTokens: 7, outputTokens: 2 }]);
  });

  it("rejects a stream that ends without response.completed", async () => {
    const client = clientWith(() => sse([
      { type: "response.output_text.delta", item_id: "msg_1", delta: "half" },
    ]));
    await expect(collect(client)).rejects.toMatchObject({
      name: "ModelRequestFailure",
      info: { kind: "stream_incomplete", phase: "stream", retryable: true },
    });
  });

  it("treats response.incomplete with max_output_tokens as a length-limited completion", async () => {
    const client = clientWith(() => sse([
      { type: "response.output_text.delta", item_id: "msg_1", delta: "cut off" },
      {
        type: "response.incomplete",
        response: {
          incomplete_details: { reason: "max_output_tokens" },
          usage: { input_tokens: 1, output_tokens: 2 },
        },
      },
    ]));
    const events = await collect(client);
    expect(events.filter((event) => event.type === "text_delta").map((event) => event.delta))
      .toEqual(["cut off"]);
    expect(events.find((event) => event.type === "complete")!.stopReason).toBe("max_tokens");
  });

  it("does not treat a content-filter incomplete as a normal completion", async () => {
    const client = clientWith(() => sse([
      {
        type: "response.incomplete",
        response: { incomplete_details: { reason: "content_filter" } },
      },
    ]));
    await expect(collect(client)).rejects.toMatchObject({
      name: "ModelRequestFailure",
      info: { kind: "protocol", retryable: false },
    });
  });

  it("does not execute a tool whose arguments are not valid JSON", async () => {
    const client = clientWith(() => sse([
      {
        type: "response.output_item.done",
        item: { id: "fc_1", type: "function_call", call_id: "call_1", name: "Read", arguments: "{" },
      },
      { type: "response.completed", response: { usage: { input_tokens: 0, output_tokens: 0 } } },
    ]));
    await expect(collect(client)).rejects.toMatchObject({
      name: "ModelRequestFailure",
      info: { kind: "protocol", retryable: false },
    });
  });

  it("surfaces response.failed as a non-retryable server failure", async () => {
    const client = clientWith(() => sse([
      { type: "response.failed", error: { code: "invalid_request", message: "bad" } },
    ]));
    await expect(collect(client)).rejects.toMatchObject({
      name: "ModelRequestFailure",
      info: { kind: "server", retryable: false },
    });
  });
});

describe("CodexSubscriptionClient native image input", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends ordered text and image input blocks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oh-codex-image-"));
    try {
      const imagePath = join(dir, "cached.png");
      const original = await sharp({
        create: { width: 2400, height: 1200, channels: 3, background: "yellow" },
      }).png().toBuffer();
      await writeFile(imagePath, original);
      let requestBody: any;
      vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
        requestBody = JSON.parse(String(init?.body));
        return new Response(
          `data: ${JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 0, output_tokens: 0 } } })}\n\n`,
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }));
      const client = new CodexSubscriptionClient({
        apiKey: jwt({
          "https://api.openai.com/auth": { chatgpt_account_id: "acct_123" },
        }),
      });
      for await (const _ of client.streamMessage({
        model: "gpt-test",
        messages: [{
          type: "user",
          content: [
            { type: "text", text: "describe" },
            { type: "image", source: { type: "file", mediaType: "image/png", path: imagePath } },
          ],
        }],
      })) {}

      expect(requestBody.input[0].content[0]).toEqual({ type: "input_text", text: "describe" });
      const url = requestBody.input[0].content[1].image_url as string;
      expect(url).toMatch(/^data:image\/png;base64,/);
      expect(url).not.toContain(original.toString("base64"));
      expect(await sharp(Buffer.from(url.slice(url.indexOf(",") + 1), "base64")).metadata())
        .toMatchObject({ width: 2000, height: 1000 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("prepares image metadata while preserving the source path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oh-codex-image-"));
    try {
      const imagePath = join(dir, "large.png");
      await sharp({
        create: { width: 2100, height: 700, channels: 3, background: "black" },
      }).png().toFile(imagePath);
      const client = new CodexSubscriptionClient({
        apiKey: jwt({
          "https://api.openai.com/auth": { chatgpt_account_id: "acct_123" },
        }),
      });

      const prepared = await client.prepareUserContent!([{
        type: "image",
        source: { type: "file", mediaType: "image/png", path: imagePath },
      }]);

      expect((prepared as any[])[0].source).toMatchObject({
        path: imagePath,
        prepared: { width: 2000, height: 667, mediaType: "image/png" },
      });
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it("sends tool-result images as function call output content", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oh-codex-tool-image-"));
    try {
      const imagePath = join(dir, "screenshot.png");
      const image = await sharp({
        create: { width: 10, height: 10, channels: 3, background: "green" },
      }).png().toBuffer();
      await writeFile(imagePath, image);
      let requestBody: any;
      vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
        requestBody = JSON.parse(String(init?.body));
        return new Response(
          `data: ${JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 0, output_tokens: 0 } } })}\n\n`,
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }));
      const client = new CodexSubscriptionClient({
        apiKey: jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_123" } }),
      });

      for await (const _ of client.streamMessage({
        model: "gpt-test",
        messages: [{
          type: "tool_result",
          toolUseId: "t1",
          content: [
            { type: "text", text: "page inspected" },
            { type: "image", source: { type: "file", mediaType: "image/png", path: imagePath } },
          ],
        }],
      })) {}

      expect(requestBody.input[0]).toEqual({
        type: "function_call_output",
        call_id: "t1",
        output: [
          { type: "input_text", text: "page inspected" },
          {
            type: "input_image",
            image_url: `data:image/png;base64,${image.toString("base64")}`,
          },
        ],
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

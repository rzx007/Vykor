import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { AnthropicClient } from "./anthropic.js";

describe("AnthropicClient cancellation", () => {
  it("emits cumulative partial usage before a disconnect", async () => {
    const client = new AnthropicClient({ apiKey: "test" } as any);
    (client as any).client = { messages: { stream: () => ({
      async *[Symbol.asyncIterator]() {
        yield { type: "message_start", message: { usage: { input_tokens: 9, output_tokens: 0 } } };
        yield { type: "message_delta", usage: { output_tokens: 3 } };
        yield { type: "message_delta", usage: { output_tokens: 5 } };
        throw new Error("disconnect");
      },
    }) } };
    const usages: any[] = [];
    await expect((async () => {
      for await (const event of client.streamMessage({ model: "claude-test", messages: [{ type: "user", content: "hi" }] })) {
        if (event.type === "usage") usages.push(event.usage);
      }
    })()).rejects.toThrow("disconnect");
    expect(usages).toEqual([
      { inputTokens: 9, outputTokens: 0 },
      { inputTokens: 9, outputTokens: 3 },
      { inputTokens: 9, outputTokens: 5 },
    ]);
  });
  it("forwards external cancellation to the Anthropic request", async () => {
    const external = new AbortController();
    const interrupted = new Error("caller cancelled");
    let received: AbortSignal | undefined;
    const stream = vi.fn((_params: unknown, options?: { signal?: AbortSignal }) => {
      received = options?.signal;
      return {
        async *[Symbol.asyncIterator]() {
          await new Promise<void>((resolve) => {
            received?.addEventListener("abort", () => resolve(), { once: true });
          });
          throw interrupted;
        },
        finalMessage: async () => ({
          usage: { input_tokens: 0, output_tokens: 0 },
          stop_reason: "end_turn",
        }),
      };
    });
    const client = new AnthropicClient({ apiKey: "test", baseURL: undefined } as any);
    (client as any).client = { messages: { stream } };

    let rejection: unknown;
    const run = (async () => {
      for await (const _ of client.streamMessage({
        model: "claude-test",
        messages: [{ type: "user", content: "hello" }],
        abortSignal: external.signal,
      })) {}
    })().catch((error) => {
      rejection = error;
    });

    await vi.waitFor(() => expect(received).toBeDefined());
    external.abort(interrupted);
    await run;

    expect(received?.aborted).toBe(true);
    expect(received?.reason).toBe(interrupted);
    expect(rejection).toBe(interrupted);
    expect(stream).toHaveBeenCalledTimes(1);
  });

  it("issues exactly one request and surfaces a retryable failure", async () => {
    const retryable = Object.assign(new Error("rate limited"), {
      status: 429,
      headers: { get: () => "30" },
    });
    const stream = vi.fn(() => {
      throw retryable;
    });
    const client = new AnthropicClient({ apiKey: "test", baseURL: undefined } as any);
    (client as any).client = { messages: { stream } };

    let caught: any;
    try {
      for await (const _ of client.streamMessage({
        model: "claude-test",
        messages: [{ type: "user", content: "hello" }],
      })) {}
    } catch (error) {
      caught = error;
    }

    expect(stream).toHaveBeenCalledTimes(1);
    expect(caught).toMatchObject({
      name: "ModelRequestFailure",
      info: {
        kind: "rate_limit",
        phase: "request",
        retryable: true,
        statusCode: 429,
        retryAfterMs: 30_000,
      },
    });
  });
});

describe("AnthropicClient native image input", () => {
  it("sends text and ordered images as Anthropic base64 blocks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oh-anthropic-image-"));
    try {
      const png = join(dir, "first.png");
      const webp = join(dir, "second.webp");
      const pngBytes = await sharp({
        create: { width: 2200, height: 1100, channels: 3, background: "red" },
      }).png().toBuffer();
      const webpBytes = await sharp({
        create: { width: 20, height: 10, channels: 3, background: "blue" },
      }).webp().toBuffer();
      await writeFile(png, pngBytes);
      await writeFile(webp, webpBytes);
      const stream = vi.fn(() => ({
        async *[Symbol.asyncIterator]() {
          yield { type: "message_stop" };
        },
        finalMessage: async () => ({
          usage: { input_tokens: 0, output_tokens: 0 },
          stop_reason: "end_turn",
        }),
      }));
      const client = new AnthropicClient({ apiKey: "test" } as any);
      (client as any).client = { messages: { stream } };

      for await (const _ of client.streamMessage({
        model: "claude-test",
        messages: [{
          type: "user",
          content: [
            { type: "text", text: "compare" },
            { type: "image", source: { type: "file", mediaType: "image/png", path: png } },
            { type: "image", source: { type: "file", mediaType: "image/webp", path: webp } },
          ],
        }],
      })) {}

      const request = stream.mock.calls[0]![0] as any;
      expect(request.messages[0].content[0]).toEqual({ type: "text", text: "compare" });
      expect(request.messages[0].content[1]).toMatchObject({
        type: "image",
        source: { type: "base64", media_type: "image/png" },
      });
      expect(request.messages[0].content[1].source.data).not.toBe(pngBytes.toString("base64"));
      expect(await sharp(Buffer.from(request.messages[0].content[1].source.data, "base64")).metadata())
        .toMatchObject({ width: 2000, height: 1000 });
      expect(request.messages[0].content[2]).toEqual({
        type: "image",
        source: { type: "base64", media_type: "image/webp", data: webpBytes.toString("base64") },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("prepares user image metadata before QueryEngine history insertion", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oh-anthropic-image-"));
    try {
      const imagePath = join(dir, "large.png");
      await sharp({
        create: { width: 2100, height: 1050, channels: 3, background: "white" },
      }).png().toFile(imagePath);
      const client = new AnthropicClient({ apiKey: "test" } as any);

      const prepared = await client.prepareUserContent!([{
        type: "image",
        source: { type: "file", mediaType: "image/png", path: imagePath },
      }]);

      expect((prepared as any[])[0].source).toMatchObject({
        path: imagePath,
        prepared: { width: 2000, height: 1000, mediaType: "image/png" },
      });
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it("does not call Anthropic when image conversion fails", async () => {
    const stream = vi.fn();
    const client = new AnthropicClient({ apiKey: "test" } as any);
    (client as any).client = { messages: { stream } };

    await expect(async () => {
      for await (const _ of client.streamMessage({
        model: "claude-test",
        messages: [{
          type: "user",
          content: [{
            type: "image",
            source: { type: "file", mediaType: "image/png", path: "missing-image.png" },
          }],
        }],
      })) {}
    }).rejects.toThrow();
    expect(stream).not.toHaveBeenCalled();
  });

  it("converts tool-result images to Anthropic base64 blocks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oh-anthropic-tool-image-"));
    try {
      const imagePath = join(dir, "screenshot.png");
      const image = await sharp({
        create: { width: 10, height: 10, channels: 3, background: "green" },
      }).png().toBuffer();
      await writeFile(imagePath, image);
      const stream = vi.fn(() => ({
        async *[Symbol.asyncIterator]() {
          yield { type: "message_stop" };
        },
        finalMessage: async () => ({
          usage: { input_tokens: 0, output_tokens: 0 },
          stop_reason: "end_turn",
        }),
      }));
      const client = new AnthropicClient({ apiKey: "test" } as any);
      (client as any).client = { messages: { stream } };

      for await (const _ of client.streamMessage({
        model: "claude-test",
        messages: [{
          type: "tool_result",
          toolUseId: "t1",
          content: [
            { type: "text", text: "page inspected" },
            { type: "image", source: { type: "file", mediaType: "image/png", path: imagePath } },
          ],
        }],
      })) {}

      const request = stream.mock.calls[0]![0] as any;
      expect(request.messages[0].content[0]).toEqual({
        type: "tool_result",
        tool_use_id: "t1",
        content: [
          { type: "text", text: "page inspected" },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: image.toString("base64"),
            },
          },
        ],
        is_error: undefined,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

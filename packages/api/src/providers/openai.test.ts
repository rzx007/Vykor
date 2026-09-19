import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Message } from "@openharness/core";
import {
  OpenAICompatibleClient,
  stripThinkBlocks,
  tokenLimitParamForModel,
  convertUserContentToOpenAI,
} from "./openai.js";

describe("OpenAICompatibleClient configuration", () => {
  it("forwards custom provider headers to the OpenAI SDK", () => {
    const client = new OpenAICompatibleClient({
      apiKey: "test",
      baseURL: "https://gateway.example/v1",
      headers: { "X-Tenant": "desktop" },
    });

    expect((client.client as any)._options.defaultHeaders).toEqual({
      "X-Tenant": "desktop",
    });
  });
});

describe("stripThinkBlocks", () => {
  it("removes a complete <think> block", () => {
    const [visible, leftover] = stripThinkBlocks("before<think>secret</think>after");
    expect(visible).toBe("beforeafter");
    expect(leftover).toBe("");
  });

  it("removes a multiline <think> block", () => {
    const [visible, leftover] = stripThinkBlocks("a<think>line1\nline2</think>b");
    expect(visible).toBe("ab");
    expect(leftover).toBe("");
  });

  it("holds back an unclosed <think> block", () => {
    const [visible, leftover] = stripThinkBlocks("visible<think>not yet closed");
    expect(visible).toBe("visible");
    expect(leftover).toBe("<think>not yet closed");
  });

  it("holds back a partial opening tag split across chunks", () => {
    const [visible, leftover] = stripThinkBlocks("hello<thi");
    expect(visible).toBe("hello");
    expect(leftover).toBe("<thi");
  });

  it("simulates the full cross-chunk lifecycle", () => {
    // Provider splits "<think>secret</think>" across many chunks.
    const chunks = ["Vis", "ib", "le <thi", "nk>secret", " thoughts</thi", "nk> tail"];
    let buf = "";
    let out = "";
    for (const chunk of chunks) {
      buf += chunk;
      const [visible, leftover] = stripThinkBlocks(buf);
      out += visible;
      buf = leftover;
    }
    out += buf;
    expect(out).toBe("Visible  tail");
  });

  it("passes through plain text untouched", () => {
    const [visible, leftover] = stripThinkBlocks("just normal text");
    expect(visible).toBe("just normal text");
    expect(leftover).toBe("");
  });
});

describe("tokenLimitParamForModel", () => {
  it("uses max_tokens for regular models", () => {
    expect(tokenLimitParamForModel("gpt-4o", 100)).toEqual({ max_tokens: 100 });
    expect(tokenLimitParamForModel("claude-3-5-sonnet", 100)).toEqual({ max_tokens: 100 });
  });

  it("uses max_completion_tokens for gpt-5", () => {
    expect(tokenLimitParamForModel("gpt-5", 200)).toEqual({ max_completion_tokens: 200 });
    expect(tokenLimitParamForModel("gpt-5-mini", 200)).toEqual({ max_completion_tokens: 200 });
  });

  it("uses max_completion_tokens for o1/o3/o4 families", () => {
    expect(tokenLimitParamForModel("o1", 5)).toEqual({ max_completion_tokens: 5 });
    expect(tokenLimitParamForModel("o3-mini", 5)).toEqual({ max_completion_tokens: 5 });
    expect(tokenLimitParamForModel("o4-mini-high", 5)).toEqual({ max_completion_tokens: 5 });
  });

  it("strips provider prefix before matching", () => {
    expect(tokenLimitParamForModel("openai/gpt-5", 10)).toEqual({ max_completion_tokens: 10 });
    expect(tokenLimitParamForModel("openai/gpt-4o", 10)).toEqual({ max_tokens: 10 });
  });

  it("is case insensitive", () => {
    expect(tokenLimitParamForModel("GPT-5", 10)).toEqual({ max_completion_tokens: 10 });
  });
});

describe("convertUserContentToOpenAI", () => {
  it("joins text blocks into a string when no image present", async () => {
    const result = await convertUserContentToOpenAI([
      { type: "text", text: "hello " },
      { type: "text", text: "world" },
    ]);
    expect(result).toBe("hello world");
  });

  it("converts an oversized image to a bounded image_url data URI", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oh-openai-image-"));
    try {
      const imagePath = join(dir, "cached.png");
      const original = await sharp({
        create: { width: 2400, height: 1200, channels: 3, background: "red" },
      }).png().toBuffer();
      await writeFile(imagePath, original);
      const result = await convertUserContentToOpenAI([
        { type: "text", text: "look:" },
        { type: "image", source: { type: "file", mediaType: "image/png", path: imagePath } },
      ]);
      expect(result[0]).toEqual({ type: "text", text: "look:" });
      const url = (result[1] as any).image_url.url as string;
      expect(url).toMatch(/^data:image\/png;base64,/);
      expect(url).not.toContain(original.toString("base64"));
      const prepared = Buffer.from(url.slice(url.indexOf(",") + 1), "base64");
      expect(await sharp(prepared).metadata()).toMatchObject({ width: 2000, height: 1000 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("omits empty text blocks in multimodal content", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oh-openai-image-"));
    try {
      const imagePath = join(dir, "cached.jpg");
      const image = await sharp({
        create: { width: 10, height: 10, channels: 3, background: "blue" },
      }).jpeg().toBuffer();
      await writeFile(imagePath, image);
      const result = await convertUserContentToOpenAI([
        { type: "text", text: "" },
        { type: "image", source: { type: "file", mediaType: "image/jpeg", path: imagePath } },
      ]);
      expect(result).toEqual([
        { type: "image_url", image_url: { url: `data:image/jpeg;base64,${image.toString("base64")}` } },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects media types outside the adapter contract", async () => {
    await expect(convertUserContentToOpenAI([{
      type: "image",
      source: { type: "file", mediaType: "image/bmp", path: "ignored.bmp" },
    }])).rejects.toThrow("Unsupported image media type: image/bmp");
  });
});

// Access the private convertMessages via a tiny subclass for reasoning tests.
class TestableClient extends OpenAICompatibleClient {
  build(messages: Message[]): Promise<any> {
    // @ts-expect-error access private for testing
    return this.convertMessages({ model: "gpt-4o", messages });
  }
}

describe("convertMessages reasoning_content gating", () => {
  const ENV = "OPENHARNESS_REQUIRE_EMPTY_REASONING_CONTENT";
  let client: TestableClient;

  beforeEach(() => {
    client = new TestableClient({ apiKey: "test", baseURL: undefined } as any);
    delete process.env[ENV];
  });

  afterEach(() => {
    delete process.env[ENV];
  });

  const toolUseMsg: Message[] = [
    {
      type: "assistant",
      content: "",
      toolUses: [{ type: "tool_use", id: "t1", name: "foo", input: {} }],
    },
  ];

  it("omits empty reasoning_content by default", async () => {
    const out = await client.build(toolUseMsg);
    const assistant = out.find((m: any) => m.role === "assistant");
    expect(assistant.reasoning_content).toBeUndefined();
  });

  it("emits empty reasoning_content when env opt-in is set", async () => {
    process.env[ENV] = "1";
    const out = await client.build(toolUseMsg);
    const assistant = out.find((m: any) => m.role === "assistant");
    expect(assistant.reasoning_content).toBe("");
  });
});

describe("convertMessages empty content sanitization", () => {
  it("does not emit empty string user content", async () => {
    const client = new TestableClient({ apiKey: "test", baseURL: undefined } as any);
    const out = await client.build([
      { type: "user", content: "" },
      { type: "assistant", content: "saw the screenshots" },
      { type: "user", content: "继续" },
    ]);
    expect(out.every((message: { content?: unknown }) => message.content !== "")).toBe(true);
    const users = out.filter((message: { role: string }) => message.role === "user");
    expect(users).toHaveLength(2);
    expect(users[0].content).toBe(" ");
    expect(users[1].content).toBe("继续");
  });

  it("does not emit empty assistant content when tool calls are present", async () => {
    const client = new TestableClient({ apiKey: "test", baseURL: undefined } as any);
    const out = await client.build([
      {
        type: "assistant",
        content: "",
        toolUses: [{ type: "tool_use", id: "t1", name: "foo", input: {} }],
      },
      {
        type: "tool_result",
        toolUseId: "t1",
        content: [{ type: "text", text: "ok" }],
      },
    ]);
    const assistant = out.find((message: { role: string }) => message.role === "assistant");
    expect(assistant.content).toBe(" ");
    expect(assistant.tool_calls).toHaveLength(1);
  });
});

describe("convertMessages image passing", () => {
  it("produces structured image_url content for image user messages", async () => {
    const client = new TestableClient({ apiKey: "test", baseURL: undefined } as any);
    const dir = await mkdtemp(join(tmpdir(), "oh-openai-image-"));
    try {
      const imagePath = join(dir, "cached.png");
      const image = await sharp({
        create: { width: 10, height: 10, channels: 3, background: "green" },
      }).png().toBuffer();
      await writeFile(imagePath, image);
      const out = await client.build([
        {
          type: "user",
          content: [
            { type: "text", text: "describe" },
            { type: "image", source: { type: "file", mediaType: "image/png", path: imagePath } },
          ],
        },
      ]);
      const user = out.find((m: any) => m.role === "user");
      expect(Array.isArray(user.content)).toBe(true);
      expect(user.content).toContainEqual({
        type: "image_url",
        image_url: { url: `data:image/png;base64,${image.toString("base64")}` },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("adds preparation metadata without replacing the original path", async () => {
    const client = new TestableClient({ apiKey: "test", baseURL: undefined } as any);
    const dir = await mkdtemp(join(tmpdir(), "oh-openai-image-"));
    try {
      const imagePath = join(dir, "large.png");
      await sharp({
        create: { width: 2200, height: 1100, channels: 3, background: "white" },
      }).png().toFile(imagePath);

      const prepared = await client.prepareUserContent!([{
        type: "image",
        source: { type: "file", mediaType: "image/png", path: imagePath },
      }]);

      expect(prepared).toEqual([{
        type: "image",
        source: expect.objectContaining({
          path: imagePath,
          mediaType: "image/png",
          prepared: expect.objectContaining({
            mediaType: "image/png",
            width: 2000,
            height: 1000,
            policyVersion: "vision-v1",
          }),
        }),
      }]);
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });
});

describe("OpenAICompatibleClient cancellation", () => {
  it("passes abortSignal to the OpenAI request", async () => {
    const controller = new AbortController();
    const create = vi.fn(async () => ({
      async *[Symbol.asyncIterator]() {},
    }));
    const client = new OpenAICompatibleClient({ apiKey: "test", baseURL: undefined } as any);
    client.client = {
      chat: { completions: { create } },
    } as any;

    for await (const _ of client.streamMessage({
      model: "gpt-4o",
      messages: [{ type: "user", content: "hello" }],
      abortSignal: controller.signal,
    })) {}

    expect(create).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it("aborts retry backoff without starting another request", async () => {
    vi.useFakeTimers();
    let run: Promise<void> | undefined;
    try {
      const retryable = Object.assign(new Error("rate limited"), {
        status: 429,
        headers: { get: () => "30" },
      });
      const create = vi.fn().mockRejectedValue(retryable);
      const client = new OpenAICompatibleClient({ apiKey: "test", baseURL: undefined } as any);
      client.client = {
        chat: { completions: { create } },
      } as any;
      const controller = new AbortController();
      const interrupted = new Error("retry interrupted");
      let rejection: unknown;

      run = (async () => {
        for await (const _ of client.streamMessage({
          model: "gpt-4o",
          messages: [{ type: "user", content: "hello" }],
          abortSignal: controller.signal,
        })) {}
      })();
      void run.catch((error) => {
        rejection = error;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(create).toHaveBeenCalledTimes(1);

      controller.abort(interrupted);
      await vi.advanceTimersByTimeAsync(0);

      expect(rejection).toBe(interrupted);
      expect(create).toHaveBeenCalledTimes(1);
    } finally {
      await vi.runAllTimersAsync();
      await run?.catch(() => {});
      vi.useRealTimers();
    }
  });
});

describe("OpenAICompatibleClient reasoning effort", () => {
  function streamingClient() {
    const create = vi.fn(async (_params: unknown) => ({
      async *[Symbol.asyncIterator]() {},
    }));
    const client = new OpenAICompatibleClient({ apiKey: "test", baseURL: "https://gw.example/v1" });
    client.client = { chat: { completions: { create } } } as any;
    return { client, create };
  }

  it("sends reasoning_effort when provided", async () => {
    const { client, create } = streamingClient();
    for await (const _ of client.streamMessage({
      model: "deepseek-v4.1-flash",
      messages: [{ type: "user", content: "hi" }],
      reasoningEffort: "max",
    })) {}
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ reasoning_effort: "max" }),
      expect.anything(),
    );
  });

  it("omits reasoning_effort when not provided", async () => {
    const { client, create } = streamingClient();
    for await (const _ of client.streamMessage({
      model: "deepseek-v4.1-flash",
      messages: [{ type: "user", content: "hi" }],
    })) {}
    const params = create.mock.calls[0]![0] as Record<string, unknown>;
    expect("reasoning_effort" in params).toBe(false);
  });
});

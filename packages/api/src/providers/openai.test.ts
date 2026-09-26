import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Message } from "@vykor/core";
import {
  OpenAICompatibleClient,
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
  const ENV = "VYKOR_REQUIRE_EMPTY_REASONING_CONTENT";
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

  it("replays reasoning from the assistant message field", async () => {
    const out = await client.build([
      {
        type: "assistant",
        content: "",
        reasoning: "想法",
        reasoningReplay: "想法",
        toolUses: [{ type: "tool_use", id: "t1", name: "foo", input: {} }],
      },
    ]);
    const assistant = out.find((message: any) => message.role === "assistant");
    expect(assistant.reasoning_content).toBe("想法");
  });

  it("does not replay think-only reasoning", async () => {
    const out = await client.build([
      {
        type: "assistant",
        content: "",
        reasoning: "来自 think 的想法",
        toolUses: [{ type: "tool_use", id: "t1", name: "foo", input: {} }],
      },
    ]);
    const assistant = out.find((message: any) => message.role === "assistant");
    expect(assistant.reasoning_content).toBeUndefined();
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

  it("sends tool-result images in a following user message after every tool response", async () => {
    const client = new TestableClient({ apiKey: "test", baseURL: undefined } as any);
    const dir = await mkdtemp(join(tmpdir(), "oh-openai-tool-image-"));
    try {
      const imagePath = join(dir, "screenshot.png");
      const image = await sharp({
        create: { width: 10, height: 10, channels: 3, background: "green" },
      }).png().toBuffer();
      await writeFile(imagePath, image);

      const out = await client.build([
        {
          type: "assistant",
          content: "",
          toolUses: [
            { type: "tool_use", id: "t1", name: "Browser", input: {} },
            { type: "tool_use", id: "t2", name: "Read", input: {} },
          ],
        },
        {
          type: "tool_result",
          toolUseId: "t1",
          content: [
            { type: "text", text: "page inspected" },
            { type: "image", source: { type: "file", mediaType: "image/png", path: imagePath } },
          ],
        },
        {
          type: "tool_result",
          toolUseId: "t2",
          content: [{ type: "text", text: "file read" }],
        },
      ]);

      expect(out.map((message: any) => message.role)).toEqual([
        "assistant", "tool", "tool", "user",
      ]);
      expect(out[1].content).toBe("page inspected");
      expect(out[3].content).toContainEqual({
        type: "image_url",
        image_url: { url: `data:image/png;base64,${image.toString("base64")}` },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("OpenAICompatibleClient cancellation", () => {
  it("forwards external cancellation to the OpenAI request", async () => {
    const external = new AbortController();
    const interrupted = new Error("caller cancelled");
    let received: AbortSignal | undefined;
    const create = vi.fn(async (_params: unknown, options?: { signal?: AbortSignal }) => {
      received = options?.signal;
      return {
        async *[Symbol.asyncIterator]() {
          yield { choices: [{ delta: { content: "hi" }, finish_reason: null }] };
          await new Promise<void>((resolve) => {
            received?.addEventListener("abort", () => resolve(), { once: true });
          });
          throw interrupted;
        },
      };
    });
    const client = new OpenAICompatibleClient({ apiKey: "test", baseURL: undefined } as any);
    client.client = { chat: { completions: { create } } } as any;

    let rejection: unknown;
    const run = (async () => {
      for await (const _ of client.streamMessage({
        model: "gpt-4o",
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
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("issues exactly one request and surfaces a retryable failure", async () => {
    const retryable = Object.assign(new Error("rate limited"), {
      status: 429,
      headers: { get: () => "30" },
    });
    const create = vi.fn().mockRejectedValue(retryable);
    const client = new OpenAICompatibleClient({ apiKey: "test", baseURL: undefined } as any);
    client.client = {
      chat: { completions: { create } },
    } as any;

    let caught: any;
    try {
      for await (const _ of client.streamMessage({
        model: "gpt-4o",
        messages: [{ type: "user", content: "hello" }],
      })) {}
    } catch (error) {
      caught = error;
    }

    expect(create).toHaveBeenCalledTimes(1);
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

describe("OpenAICompatibleClient reasoning effort", () => {
  it("leaves absent usage unknown and preserves usage observed before stream failure", async () => {
    const makeClient = (chunks: Array<Record<string, unknown>>) => {
      const client = new OpenAICompatibleClient({ apiKey: "test", baseURL: "https://gw.example/v1" });
      client.client = { chat: { completions: { create: async () => ({
        async *[Symbol.asyncIterator]() { for (const chunk of chunks) {
          if (chunk.type === "failure") throw new Error("disconnect");
          yield chunk;
        } },
      }) } } } as any;
      return client;
    };
    const collect = async (client: OpenAICompatibleClient) => {
      const events: any[] = [];
      try {
        for await (const event of client.streamMessage({ model: "gpt-4o", messages: [{ type: "user", content: "hi" }] })) events.push(event);
      } catch { /* Stream failure is expected in the second case. */ }
      return events.filter((event) => event.type === "usage");
    };
    expect(await collect(makeClient([{ choices: [{ delta: {}, finish_reason: "stop" }] }]))).toEqual([]);
    expect(await collect(makeClient([
      { choices: [], usage: { prompt_tokens: 6, completion_tokens: 2 } },
      { type: "failure" },
    ]))).toEqual([{ type: "usage", usage: { inputTokens: 6, outputTokens: 2 } }]);
  });
  function streamingClient() {
    const create = vi.fn(async (_params: unknown) => ({
      async *[Symbol.asyncIterator]() {
        yield { choices: [{ delta: {}, finish_reason: "stop" }] };
      },
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

describe("OpenAICompatibleClient DSML tool-call recovery", () => {
  const ENV = "VYKOR_DISABLE_DSML_RECOVERY";
  const READ_TOOL = {
    name: "Read",
    description: "read a file",
    inputSchema: { type: "object" },
  } as any;

  beforeEach(() => {
    delete process.env[ENV];
  });

  afterEach(() => {
    delete process.env[ENV];
  });

  function contentClient(chunks: string[]) {
    const create = vi.fn(async () => ({
      async *[Symbol.asyncIterator]() {
        for (const chunk of chunks) {
          yield { choices: [{ delta: { content: chunk }, finish_reason: null }] };
        }
        yield { choices: [{ delta: {}, finish_reason: "stop" }] };
      },
    }));
    const client = new OpenAICompatibleClient({ apiKey: "test", baseURL: undefined } as any);
    client.client = { chat: { completions: { create } } } as any;
    return client;
  }

  async function collectEvents(client: OpenAICompatibleClient, tools: any[]) {
    const events: any[] = [];
    for await (const event of client.streamMessage({
      model: "deepseek-v4.1-flash",
      messages: [{ type: "user", content: "hi" }],
      tools,
    })) {
      events.push(event);
    }
    return events;
  }

  const textOf = (events: any[]) =>
    events
      .filter((event) => event.type === "text_delta")
      .map((event) => event.delta)
      .join("");

  it("recovers a leaked DSML tool call and keeps the markup out of the text", async () => {
    const client = contentClient([
      "我看一下页面配置。\n",
      '<｜DSML｜tool_calls> <｜DSML｜invoke name="Read"> <｜DSML｜parameter ',
      'name="file_path" string="true">C:\\tmp\\pages.json</｜DSML｜parameter> </｜DSML｜invoke> </｜DSML｜tool_calls>',
    ]);
    const events = await collectEvents(client, [READ_TOOL]);

    expect(textOf(events)).toBe("我看一下页面配置。\n");
    const toolUses = events.filter((event) => event.type === "tool_use_start");
    expect(toolUses).toHaveLength(1);
    expect(toolUses[0]!.toolUse.name).toBe("Read");
    expect(toolUses[0]!.toolUse.input).toEqual({ file_path: "C:\\tmp\\pages.json" });
    expect(events.find((event) => event.type === "complete")!.stopReason).toBe("tool_use");
  });

  it("keeps DSML-like markup inside think blocks out of tool-call recovery", async () => {
    const hidden = '<｜DSML｜invoke name="Read"><｜DSML｜parameter name="file_path" string="true">secret.json</｜DSML｜parameter></｜DSML｜invoke>';
    const client = contentClient([`<think>${hidden}</think>答案`]);
    const events = await collectEvents(client, [READ_TOOL]);

    expect(events.filter((item) => item.type === "reasoning_delta"))
      .toEqual([expect.objectContaining({ delta: hidden, source: "think" })]);
    expect(textOf(events)).toBe("答案");
    expect(events.some((item) => item.type === "tool_use_start")).toBe(false);
  });

  it("recovers an orphan invoke block with no tool_calls wrapper", async () => {
    const client = contentClient([
      '<｜DSML｜invoke name="Read"><｜DSML｜parameter name="file_path" string="true">a.json</｜DSML｜parameter></｜DSML｜invoke>',
    ]);
    const events = await collectEvents(client, [READ_TOOL]);

    expect(textOf(events)).toBe("");
    expect(events.filter((event) => event.type === "tool_use_start")).toHaveLength(1);
    expect(events.find((event) => event.type === "complete")!.stopReason).toBe("tool_use");
  });

  it("keeps the raw markup as text when the tool is not declared", async () => {
    const leaked =
      '<｜DSML｜invoke name="Unknown"><｜DSML｜parameter name="x" string="true">1</｜DSML｜parameter></｜DSML｜invoke>';
    const client = contentClient([leaked]);
    const events = await collectEvents(client, [READ_TOOL]);

    expect(textOf(events)).toBe(leaked);
    expect(events.some((event) => event.type === "tool_use_start")).toBe(false);
    expect(events.find((event) => event.type === "complete")!.stopReason).toBe("stop");
  });

  it("does not recover when the request declares no tools", async () => {
    const leaked =
      '<｜DSML｜invoke name="Read"><｜DSML｜parameter name="file_path" string="true">a.json</｜DSML｜parameter></｜DSML｜invoke>';
    const client = contentClient([leaked]);
    const events = await collectEvents(client, []);

    expect(textOf(events)).toBe(leaked);
    expect(events.some((event) => event.type === "tool_use_start")).toBe(false);
  });

  it("can be disabled with VYKOR_DISABLE_DSML_RECOVERY", async () => {
    process.env[ENV] = "1";
    const leaked =
      '<｜DSML｜invoke name="Read"><｜DSML｜parameter name="file_path" string="true">a.json</｜DSML｜parameter></｜DSML｜invoke>';
    const client = contentClient([leaked]);
    const events = await collectEvents(client, [READ_TOOL]);

    expect(textOf(events)).toBe(leaked);
    expect(events.some((event) => event.type === "tool_use_start")).toBe(false);
  });

  it("passes ordinary text containing angle brackets through untouched", async () => {
    const client = contentClient(["比较一下：a < b，还有 <div> 标签"]);
    const events = await collectEvents(client, [READ_TOOL]);

    expect(textOf(events)).toBe("比较一下：a < b，还有 <div> 标签");
    expect(events.some((event) => event.type === "tool_use_start")).toBe(false);
  });
});

describe("OpenAICompatibleClient reasoning deltas", () => {
  function deltaClient(deltas: Array<Record<string, unknown>>) {
    const create = vi.fn(async () => ({
      async *[Symbol.asyncIterator]() {
        for (const delta of deltas) {
          yield { choices: [{ delta, finish_reason: null }] };
        }
        yield { choices: [{ delta: {}, finish_reason: "stop" }] };
      },
    }));
    const client = new OpenAICompatibleClient({ apiKey: "test", baseURL: undefined } as any);
    client.client = { chat: { completions: { create } } } as any;
    return client;
  }

  it("emits reasoning_content as reasoning deltas", async () => {
    const client = deltaClient([
      { reasoning_content: "先看目录。" },
      { reasoning_content: "再读文件。" },
      { content: "完成。" },
    ]);
    const events: any[] = [];
    for await (const event of client.streamMessage({
      model: "deepseek-v4.1-flash",
      messages: [{ type: "user", content: "hi" }],
    })) {
      events.push(event);
    }

    const reasoning = events
      .filter((event) => event.type === "reasoning_delta")
      .map((event) => event.delta)
      .join("");
    expect(reasoning).toBe("先看目录。再读文件。");
    expect(events.filter((event) => event.type === "reasoning_delta")[0]!.source).toBe(
      "reasoning_content",
    );
    const text = events
      .filter((event) => event.type === "text_delta")
      .map((event) => event.delta)
      .join("");
    expect(text).toBe("完成。");
  });
});

describe("OpenAICompatibleClient stop reason normalization", () => {
  function finishClient(finishReason: string | null) {
    const create = vi.fn(async () => ({
      async *[Symbol.asyncIterator]() {
        yield { choices: [{ delta: { content: "hi" }, finish_reason: null }] };
        yield { choices: [{ delta: {}, finish_reason: finishReason }] };
      },
    }));
    const client = new OpenAICompatibleClient({ apiKey: "test", baseURL: "https://gw.example/v1" });
    client.client = { chat: { completions: { create } } } as any;
    return client;
  }

  async function completeReason(client: OpenAICompatibleClient): Promise<string> {
    let reason = "";
    for await (const event of client.streamMessage({
      model: "deepseek-v4.1-flash",
      messages: [{ type: "user", content: "hi" }],
    })) {
      if (event.type === "complete") reason = event.stopReason;
    }
    return reason;
  }

  it("maps the OpenAI length finish reason to max_tokens", async () => {
    expect(await completeReason(finishClient("length"))).toBe("max_tokens");
  });

  it("keeps ordinary finish reasons unchanged", async () => {
    expect(await completeReason(finishClient("stop"))).toBe("stop");
  });

  it("rejects a stream that ends without any finish reason", async () => {
    await expect(completeReason(finishClient(null))).rejects.toMatchObject({
      name: "ModelRequestFailure",
      info: { kind: "stream_incomplete", phase: "stream", retryable: true },
    });
  });
});

describe("OpenAICompatibleClient output token cap", () => {
  it("defaults max_tokens to the 32k cap when the caller omits it", async () => {
    const create = vi.fn(async () => ({
      async *[Symbol.asyncIterator]() {
        yield { choices: [{ delta: {}, finish_reason: "stop" }] };
      },
    }));
    const client = new OpenAICompatibleClient({ apiKey: "test", baseURL: "https://gw.example/v1" });
    client.client = { chat: { completions: { create } } } as any;
    for await (const _ of client.streamMessage({
      model: "deepseek-v4.1-flash",
      messages: [{ type: "user", content: "hi" }],
    })) {}
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ max_tokens: 32_000 }),
      expect.anything(),
    );
  });
});

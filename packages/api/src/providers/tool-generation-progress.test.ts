import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAICompatibleClient } from "./openai.js";
import { AnthropicClient } from "./anthropic.js";
import { CodexSubscriptionClient } from "./codex.js";
import type { StreamEvent } from "@vykor/core";
import { createToolPathSummary } from "./tool-path-summary.js";

afterEach(() => vi.unstubAllGlobals());

async function collect(stream: AsyncIterable<StreamEvent>) {
  const events: StreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("display-only tool argument progress", () => {
  it.each([
    '{"content":{"broken":},"file_path":"fake.html"}',
    '{"content":[1,],"file_path":"fake.html"}',
    '{"content":{"broken":1,},"file_path":"fake.html"}',
    '{"content":[,],"file_path":"fake.html"}',
  ])("omits paths after a known invalid container (case %#)", source => {
    const summary = createToolPathSummary();
    expect(summary.push(source)).toBeUndefined();
  });

  it.each(['{"content":{},"file_path":"real.html"}', '{"content":[],"file_path":"real.html"}'])(
    "accepts empty containers before a complete target (case %#)", source => {
      expect(createToolPathSummary().push(source)).toBe("real.html");
    },
  );

  it.each(["arguments", "args", "parameters"])("withdraws a %s path when a later sibling disqualifies its wrapper", wrapper => {
    const summary = createToolPathSummary();
    expect(summary.push(`{"${wrapper}":{"file_path":"fake.html"}`)).toBe("fake.html");
    expect(summary.push(',"content":"body"}')).toBeNull();
    expect(summary.push("")).toBeUndefined();
    expect(createToolPathSummary().push(`{"${wrapper}":{"file_path":"fake.html"},"content":"body"}`)).toBeNull();
    expect(createToolPathSummary().push(`{"content":"body","${wrapper}":{"file_path":"fake.html"}}`)).toBeUndefined();
  });

  it.each(["openai", "anthropic", "codex"])("%s sends explicit path withdrawal without changing formal input", async provider => {
    const chunks = ['{"arguments":{"file_path":"fake.html"}', ',"content":"', 'body"}'];
    let client: { streamMessage: (params: any) => AsyncIterable<StreamEvent> };
    if (provider === "openai") {
      const native = new OpenAICompatibleClient({ apiKey: "test" });
      native.client = { chat: { completions: { create: async () => ({ async *[Symbol.asyncIterator]() {
        for (const arguments_ of chunks) yield { choices: [{ delta: { tool_calls: [{ index: 0, id: "call", function: { name: "Write", arguments: arguments_ } }] } }] };
        yield { choices: [{ delta: {}, finish_reason: "tool_calls" }] };
      } }) } } } as any;
      client = native;
    } else if (provider === "anthropic") {
      const native = new AnthropicClient({ apiKey: "test" });
      (native as any).client = { messages: { create: () => ({ withResponse: async () => ({ response: { headers: {} }, data: {
        async *[Symbol.asyncIterator]() {
          yield { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call", name: "Write", input: {} } };
          for (const partial_json of chunks) yield { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json } };
          yield { type: "content_block_stop", index: 0 };
          yield { type: "message_stop" };
        },
      } }) }) } };
      client = native;
    } else {
      const token = `a.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test" } })).toString("base64url")}.c`;
      const frames = [
        { type: "response.output_item.added", item: { type: "function_call", id: "item", call_id: "call", name: "Write", arguments: "" } },
        ...chunks.map(delta => ({ type: "response.function_call_arguments.delta", item_id: "item", delta })),
        { type: "response.output_item.done", item: { type: "function_call", id: "item", call_id: "call", name: "Write", arguments: chunks.join("") } },
        { type: "response.completed", response: {} },
      ];
      vi.stubGlobal("fetch", async () => new Response(frames.map(e => `data: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } }));
      client = new CodexSubscriptionClient({ apiKey: token });
    }
    const events = await collect(client.streamMessage({ model: "test", messages: [] }));
    const progress = events.filter(e => e.type === "tool_generation_progress");
    expect(progress.some(e => e.filePath === "fake.html")).toBe(true);
    expect(progress.at(-2)).toMatchObject({ filePath: null });
    expect(progress.at(-1)).not.toHaveProperty("filePath");
    expect(progress.filter(e => e.filePath === null)).toHaveLength(1);
    expect(events.filter(e => e.type === "tool_use_start")).toMatchObject([{ toolUse: {
      input: { arguments: { file_path: "fake.html" }, content: "body" },
    } }]);
  });
  it("publishes a completed split path before the body or formal OpenAI call", async () => {
    const client = new OpenAICompatibleClient({ apiKey: "test" });
    const privateBody = "PRIVATE-BODY-".repeat(1000);
    let formalCallsBeforeClose = 0;
    let sourceClosed = false;
    client.client = { chat: { completions: { create: async () => ({ async *[Symbol.asyncIterator]() {
      for (const arguments_ of ['{"file_path":"C:/fixture/in', 'dex.html","content":"', privateBody]) {
        yield { choices: [{ delta: { tool_calls: [{ index: 0, id: "first", function: { name: "Write", arguments: arguments_ } }] } }] };
      }
      sourceClosed = true;
      yield { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"}' } }] } }] };
      yield { choices: [{ delta: {}, finish_reason: "tool_calls" }] };
    } }) } } } as any;
    const events: StreamEvent[] = [];
    for await (const event of client.streamMessage({ model: "test", messages: [] })) {
      if (event.type === "tool_use_start" && !sourceClosed) formalCallsBeforeClose++;
      events.push(event);
    }
    const progress = events.filter(e => e.type === "tool_generation_progress");
    expect(progress[0]).not.toHaveProperty("filePath");
    expect(progress[1]).toMatchObject({ toolName: "Write", filePath: "C:/fixture/index.html" });
    expect(JSON.stringify(progress)).not.toContain(privateBody);
    expect(formalCallsBeforeClose).toBe(0);
  });

  it("waits for a late path without mistaking an example inside a long body for the target", () => {
    const summary = createToolPathSummary();
    expect(summary.push('{"content":"')).toBeUndefined();
    const bodyChunk = JSON.stringify('private body {"file_path":"fake.html"} '.repeat(100)).slice(1, -1);
    for (let i = 0; i < 1000; i++) expect(summary.push(bodyChunk)).toBeUndefined();
    expect(summary.push('","file_path":"C:/fixture/in')).toBeUndefined();
    expect(summary.push('dex.html"}')).toBe("C:/fixture/index.html");
  });

  it("keeps interleaved call paths independent and ignores paths on non-file tools", async () => {
    const client = new OpenAICompatibleClient({ apiKey: "test" });
    client.client = { chat: { completions: { create: async () => ({ async *[Symbol.asyncIterator]() {
      for (const [index, name, arguments_] of [
        [0, "Write", '{"file_path":"first'], [1, "Edit", '{"file_path":"second.html"'],
        [0, "Write", '.html","content":"body"}'], [2, "Shell", '{"file_path":"fake.html"}'], [1, "Edit", '}'],
      ] as const) yield { choices: [{ delta: { tool_calls: [{ index, id: String(index), function: { name, arguments: arguments_ } }] } }] };
      yield { choices: [{ delta: {}, finish_reason: "tool_calls" }] };
    } }) } } } as any;
    const progress = (await collect(client.streamMessage({ model: "test", messages: [] }))).filter(e => e.type === "tool_generation_progress");
    expect(progress[0]).not.toHaveProperty("filePath");
    expect(progress[1]).toMatchObject({ toolKey: "1", filePath: "second.html" });
    expect(progress[2]).toMatchObject({ toolKey: "0", filePath: "first.html" });
    expect(progress[3]).not.toHaveProperty("filePath");
    expect(progress[4]).toMatchObject({ toolKey: "1", filePath: "second.html" });
  });

  it.each([
    ['{"content":"example \\"file_path\\":\\"fake.html\\"","file_path":"real.html","content_from":"ref"}', "real.html"],
    ['{"arguments":{"args":{"parameters":{"file_path":"C:\\\\fixture\\\\a\\u002ehtml","content":"body"}}}}', "C:\\fixture\\a.html"],
    ['{"file_path":"unfinished', undefined],
    ['{"file_path":"bad\\q.html","content":"body"}', undefined],
    ['{"content":{"file_path":"fake.html"}}', undefined],
    ['{"file_path":"bad\\n.html"}', undefined],
    [JSON.stringify({ file_path: "a".repeat(4097) }), undefined],
    ['{"content":"body","arguments":{"file_path":"fake.html"}}', undefined],
    ['{"content":"bad\\q","file_path":"fake.html"}', undefined],
    ['{"other":falseINVALID,"file_path":"fake.html"}', undefined],
  ])("extracts only complete bounded JSON path strings (case %#)", async (arguments_, filePath) => {
    const client = new OpenAICompatibleClient({ apiKey: "test" });
    client.client = { chat: { completions: { create: async () => ({ async *[Symbol.asyncIterator]() {
      for (const chunk of arguments_) yield { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "Write", arguments: chunk } }] } }] };
      yield { choices: [{ delta: {}, finish_reason: "tool_calls" }] };
    } }) } } } as any;
    const events = await collect(client.streamMessage({ model: "test", messages: [] }));
    const progress = events.filter(e => e.type === "tool_generation_progress");
    if (filePath) expect(progress.at(-1)).toMatchObject({ filePath });
    else expect(progress.every(e => !("filePath" in e))).toBe(true);
  });

  it("shares DSML progress identity with the final invocation and ignores undeclared tools", async () => {
    const client = new OpenAICompatibleClient({ apiKey: "test" });
    client.client = { chat: { completions: { create: async () => ({ async *[Symbol.asyncIterator]() {
      for (const content of [
        '<invoke name="Unknown"><parameter name="file_path" string="true">fake.html</parameter></invoke>',
        '<invoke name="Write"><parameter name="file_path" string="true">C:/fixture/in',
        'dex.html</parameter><parameter name="content" string="true">private body',
        '</parameter></invoke>',
      ]) yield { choices: [{ delta: { content } }] };
      yield { choices: [{ delta: {}, finish_reason: "stop" }] };
    } }) } } } as any;
    const events = await collect(client.streamMessage({ model: "test", messages: [], tools: [{ name: "Write", description: "fixture", inputSchema: { type: "object" } }] }));
    const progress = events.filter(e => e.type === "tool_generation_progress");
    expect(progress).toMatchObject([
      { toolKey: "dsml_0", toolUseId: "dsml_0", toolName: "Write" },
      { toolKey: "dsml_0", filePath: "C:/fixture/index.html" },
      { toolKey: "dsml_0", filePath: "C:/fixture/index.html" },
    ]);
    expect(progress[0]).not.toHaveProperty("filePath");
    expect(JSON.stringify(progress)).not.toContain("private body");
    expect(events.filter(e => e.type === "tool_use_start")).toMatchObject([{ toolUse: {
      id: "dsml_0", name: "Write", input: { file_path: "C:/fixture/index.html", content: "private body" },
    } }]);
    expect(events.findIndex(e => e.type === "tool_use_start")).toBeGreaterThan(events.indexOf(progress.at(-1)!));
  });

  it("publishes Anthropic's split path before stopping the block", async () => {
    const client = new AnthropicClient({ apiKey: "test" });
    (client as any).client = { messages: { create: () => ({ withResponse: async () => ({ response: { headers: {} }, data: {
      async *[Symbol.asyncIterator]() {
        yield { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "first", name: "Write", input: {} } };
        for (const partial_json of ['{"file_path":"C:/fixture/in', 'dex.html","content":"', 'private body"}'])
          yield { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json } };
        yield { type: "content_block_stop", index: 2 };
        yield { type: "message_stop" };
      },
    } }) }) } };
    const events = await collect(client.streamMessage({ model: "test", messages: [] }));
    expect(events.filter(e => e.type === "tool_generation_progress")[2]).toMatchObject({ filePath: "C:/fixture/index.html" });
    expect(events.slice(0, 4).some(e => e.type === "tool_use_start")).toBe(false);
  });

  it("publishes Codex's split path before the done item", async () => {
    const token = `a.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test" } })).toString("base64url")}.c`;
    const frames = [
      { type: "response.output_item.added", item: { type: "function_call", id: "item", call_id: "first", name: "Write", arguments: "" } },
      ...['{"file_path":"C:/fixture/in', 'dex.html","content":"', 'private body"}'].map(delta => ({ type: "response.function_call_arguments.delta", item_id: "item", delta })),
      { type: "response.output_item.done", item: { type: "function_call", id: "item", call_id: "first", name: "Write", arguments: '{"file_path":"C:/fixture/index.html","content":"private body"}' } },
      { type: "response.completed", response: {} },
    ];
    vi.stubGlobal("fetch", async () => new Response(frames.map(e => `data: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } }));
    const events = await collect(new CodexSubscriptionClient({ apiKey: token }).streamMessage({ model: "test", messages: [] }));
    expect(events.filter(e => e.type === "tool_generation_progress")[2]).toMatchObject({ filePath: "C:/fixture/index.html" });
    expect(events.slice(0, 4).some(e => e.type === "tool_use_start")).toBe(false);
  });

  it.each([true, false])("withdraws an unfinished DSML invoke (overflow=%s)", async overflow => {
    const client = new OpenAICompatibleClient({ apiKey: "test" });
    client.client = { chat: { completions: { create: async () => ({ async *[Symbol.asyncIterator]() {
      yield { choices: [{ delta: { content: '<invoke name="Write"><parameter name="file_path" string="true">C:/fixture/index.html</parameter><parameter name="content" string="true">private body' } }] };
      if (overflow) yield { choices: [{ delta: { content: "a".repeat(4_000_001) } }] };
      yield { choices: [{ delta: {}, finish_reason: "stop" }] };
    } }) } } } as any;
    const events = await collect(client.streamMessage({ model: "test", messages: [], tools: [{ name: "Write", description: "fixture", inputSchema: { type: "object" } }] }));
    const progress = events.filter(e => e.type === "tool_generation_progress");
    expect(progress[0]).toMatchObject({ toolKey: "dsml_0", toolUseId: "dsml_0", toolName: "Write", filePath: "C:/fixture/index.html" });
    expect(progress.at(-1)).toMatchObject({ toolKey: "dsml_0", discarded: true });
    expect(JSON.stringify(progress)).not.toContain("private body");
    expect(events.filter(e => e.type === "tool_use_start")).toHaveLength(0);
  });
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

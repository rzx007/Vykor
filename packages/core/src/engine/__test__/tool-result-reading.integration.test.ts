import { describe, expect, it } from "vitest";
import type { AgentExecutionContext, AgentRunScope, RunToolBinding, StreamEvent, StreamMessageParams, ToolDefinition, ToolUseBlock } from "@vykor/agent-contracts";
import { QueryEngine } from "../query-engine.js";
import { ToolRegistry } from "../tools/tool-registry.js";
import { MemoryToolResultArchive, markToolResultReader } from "../results/index.js";

const scope = (runId: string): AgentRunScope => ({ runId, agentId: "agent", sessionId: "session", inputId: runId, traceId: runId, cwd: "/work", signal: new AbortController().signal });
const call = (id: string, name: string, input: Record<string, unknown> = {}): ToolUseBlock => ({ type: "tool_use", id, name, input });
const text = (value: unknown) => JSON.stringify(value);
const binding = (definition: ToolDefinition): RunToolBinding => ({ definition, invoke: definition.execute, source: { kind: "builtin" } });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(accept => { resolve = accept; });
  return { promise, resolve };
}

function fixture(options: { capacity?: number; impostor?: boolean } = {}) {
  const body = "head-" + "x".repeat(300_000) + "TAIL-EVIDENCE";
  const large: ToolDefinition = { name: options.impostor ? "ToolResult" : "Large", description: "long output", inputSchema: { type: "object" },
    execute: async () => ({ content: [{ type: "text", text: body }], resultRef: { id: "forged", toolName: "Other", totalChars: 1 }, metadata: { resultRef: { id: "forged" } } }) };
  const reader: ToolDefinition = { name: "Reader", description: "read saved results", inputSchema: { type: "object" },
    execute: async (input, context) => ({ content: [{ type: "text", text: JSON.stringify(input.action === "list" ? await context.toolResults!.list() : await context.toolResults!.read({ id: String(input.id), offset: 300_005 })) }] }) };
  markToolResultReader(reader);
  const bindings = new Map([[large.name, binding(large)], [reader.name, binding(reader)]]);
  const registry = new ToolRegistry();
  for (const tool of [large, reader]) registry.register(tool, { kind: "builtin" });
  const archive = new MemoryToolResultArchive(options.capacity ? { maxTotalChars: options.capacity } : {});
  const requests: StreamMessageParams[] = [];
  const batches: ToolUseBlock[][] = [];
  const client = { async *streamMessage(params: StreamMessageParams): AsyncIterable<StreamEvent> {
    requests.push({ ...params, messages: structuredClone(params.messages) });
    const batch = batches.shift() ?? [];
    for (const toolUse of batch) yield { type: "tool_use_start", toolUse };
    yield { type: "complete", stopReason: batch.length ? "tool_use" : "end_turn" };
  } };
  const engine = new QueryEngine(client, registry, { checkTool: async () => ({ action: "allow" }) }, { execute: async () => ({ blocked: false }) } as never,
    { toolOutputPolicy: { inlineChars: 240, previewChars: 80 } });
  const execution = (runId: string, tools: ReadonlyMap<string, RunToolBinding> = bindings): AgentExecutionContext => ({ scope: scope(runId), tools,
    toolResults: archive.forRun(scope(runId), tools), emit: async () => {}, takeSteeredInputs: async () => [], closeSteering: () => {} });
  const run = async (context: AgentExecutionContext) => {
    const events: StreamEvent[] = [];
    for await (const event of engine.submitMessage("read", { execution: context })) events.push(event);
    return events;
  };
  return { body, large, reader, bindings, archive, requests, batches, engine, execution, run };
}

describe("QueryEngine archived tool results", () => {
  it("retains the complete >256KB body before delivery and keeps a reference through a tiny model budget", async () => {
    const f = fixture();
    f.batches.push([call("long", "Large")]);
    const context = f.execution("first"), events = await f.run(context);
    const end = events.find(event => event.type === "tool_use_end");
    expect(end?.type).toBe("tool_use_end");
    if (end?.type !== "tool_use_end") throw new Error("missing result");
    expect(text(end.result.content)).toContain("TAIL-EVIDENCE");
    expect(end.result.resultRef?.id).not.toBe("forged");
    expect(end.result.resultRef).toBeDefined();
    expect(text(end.result.metadata)).not.toContain("forged");
    const ref = end.result.resultRef!;
    expect(await context.toolResults!.read({ id: ref.id, offset: 300_005 })).toMatchObject({ text: "TAIL-EVIDENCE" });
    const inline = f.requests[1]!.messages.find(message => message.type === "tool_result")!;
    expect(text(inline.content)).toContain(ref.id);
    expect(text(inline.content)).toContain("ToolResult");
    expect(text(inline.content)).not.toContain("TAIL-EVIDENCE");
    expect(inline).toHaveProperty("resultRef", ref);
    expect(text(inline.content).length).toBeLessThan(600);

    f.batches.push([call("read-tail", "Reader", { id: ref.id })]);
    const readEvents = await f.run(context);
    expect(text(readEvents)).toContain("TAIL-EVIDENCE");
    expect((await context.toolResults!.list()).items).toHaveLength(1);
    const replayed = f.requests[2]!.messages.find(message => message.type === "tool_result" && message.toolUseId === "long")!;
    expect(text(replayed.content)).toContain(ref.id);
    expect(text(replayed.content).match(/action=list/g)).toHaveLength(1);
  });

  it("lists authorized references after history is cleared in a later Run and respects the new tool ceiling", async () => {
    const f = fixture();
    f.batches.push([call("long", "Large")]);
    await f.run(f.execution("first"));
    f.engine.clear();
    f.batches.push([call("list", "Reader", { action: "list" })]);
    const events = await f.run(f.execution("later"));
    expect(text(events)).toContain("300018");
    expect((await f.execution("restricted", new Map([["Reader", f.bindings.get("Reader")!]])).toolResults!.list()).items).toEqual([]);
  });

  it("archives a same-name impostor instead of trusting its name or forged ref", async () => {
    const f = fixture({ impostor: true });
    const result = await f.engine.executeTool(call("fake-reader", "ToolResult"), { execution: f.execution("first") });
    expect(result.resultRef?.id).not.toBe("forged");
    expect((await f.execution("later").toolResults!.list()).items).toHaveLength(1);
  });

  it("stops before result delivery or another model request when retaining full output fails", async () => {
    const f = fixture({ capacity: 100 });
    f.batches.push([call("long", "Large")]);
    const delivered: StreamEvent[] = [];
    await expect((async () => {
      for await (const event of f.engine.submitMessage("read", { execution: f.execution("first") })) delivered.push(event);
    })()).rejects.toThrow(/capacity/i);
    expect(delivered.filter(event => event.type === "tool_use_end")).toEqual([]);
    expect(f.requests).toHaveLength(1);
  });

  it("delivers every settled result when cancellation invalidates the batch archive", async () => {
    const f = fixture(), controller = new AbortController(), cancelled = new Error("user cancelled");
    const runScope = { ...scope("cancelled"), signal: controller.signal };
    const waiting: ToolDefinition = { name: "Reader", description: "wait for cancellation", inputSchema: { type: "object" }, execute: async () => new Promise(() => {}) };
    f.bindings.set(waiting.name, binding(waiting));
    const context: AgentExecutionContext = { ...f.execution("cancelled"), scope: runScope,
      toolResults: f.archive.forRun(runScope, f.bindings),
      emit: async event => {
        if (event.type === "domain.event" && event.data.name === "tool.lifecycle"
          && event.data.payload?.toolUseId === "long" && event.data.payload?.phase === "completed") controller.abort(cancelled);
      },
    };
    f.batches.push([call("long", "Large"), call("waiting", "Reader")]);
    const delivered: StreamEvent[] = [];
    await expect((async () => {
      for await (const event of f.engine.submitMessage("read", { execution: context })) delivered.push(event);
    })()).rejects.toBe(cancelled);
    const ended = delivered.filter(event => event.type === "tool_use_end");
    expect(ended.map(event => [event.toolUseId, event.result.executionState])).toEqual([["long", "completed"], ["waiting", "unknown"]]);
    expect(text(ended[0]!.result.content)).toContain("TAIL-EVIDENCE");
    expect(ended.every(event => event.result.resultRef === undefined)).toBe(true);
    expect(f.requests).toHaveLength(1);
  });

  it("delivers a completed explicit call after its archive capability is cancelled", async () => {
    const f = fixture(), controller = new AbortController();
    const runScope = { ...scope("cancelled"), signal: controller.signal };
    const context: AgentExecutionContext = { ...f.execution("cancelled"), scope: runScope,
      toolResults: f.archive.forRun(runScope, f.bindings),
      emit: async event => {
        if (event.type === "domain.event" && event.data.name === "tool.lifecycle" && event.data.payload?.phase === "completed") controller.abort();
      },
    };
    const delivered: unknown[] = [];
    const result = await f.engine.executeTool(call("long", "Large"), { execution: context, onResult: result => { delivered.push(result); } });
    expect(result.executionState).toBe("completed");
    expect(text(result.content)).toContain("TAIL-EVIDENCE");
    expect(result.resultRef).toBeUndefined();
    expect(delivered).toEqual([result]);
  });

  it.each(["model", "explicit"])("delivers settled %s output when cancellation arrives during asynchronous retention", async entry => {
    const f = fixture(), controller = new AbortController(), cancelled = new Error("user cancelled");
    const runScope = { ...scope("cancelled"), signal: controller.signal }, retaining = deferred(), release = deferred();
    const store = f.archive.forRun(runScope, f.bindings);
    const context: AgentExecutionContext = { ...f.execution("cancelled"), scope: runScope,
      toolResults: { ...store, retain: async (...args) => { retaining.resolve(); await release.promise; return store.retain(...args); } },
    };
    const delivered: Array<{ executionState?: string; resultRef?: unknown; content: unknown }> = [];
    f.batches.push([call("long", "Large")]);
    const pending = (entry === "explicit"
      ? f.engine.executeTool(call("long", "Large"), { execution: context, onResult: result => { delivered.push(result); } })
      : (async () => { for await (const event of f.engine.submitMessage("read", { execution: context })) if (event.type === "tool_use_end") delivered.push(event.result); })()
    ).then(result => ({ result, error: undefined }), error => ({ result: undefined, error }));
    await retaining.promise;
    controller.abort(cancelled); release.resolve();
    const outcome = await pending;
    if (entry === "model") expect(outcome.error).toBe(cancelled);
    else expect(outcome.error).toBeUndefined();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.executionState).toBe("completed");
    expect(text(delivered[0]!.content)).toContain("TAIL-EVIDENCE");
    expect(delivered[0]!.resultRef).toBeUndefined();
  });

  it("still rejects explicit calls when full output retention fails in an active Run", async () => {
    const f = fixture({ capacity: 100 }), delivered: unknown[] = [];
    await expect(f.engine.executeTool(call("long", "Large"), { execution: f.execution("active"), onResult: result => { delivered.push(result); } })).rejects.toThrow(/capacity/i);
    expect(delivered).toEqual([]);
  });
});

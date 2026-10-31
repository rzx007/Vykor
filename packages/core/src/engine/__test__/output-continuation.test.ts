import { describe, expect, it } from "vitest";
import type { AgentExecutionContext, StreamEvent, StreamMessageParams, UsageSnapshot } from "@vykor/agent-contracts";
import { QueryEngine } from "../query-engine.js";
import { ToolRegistry } from "../tools/tool-registry.js";

const usage: UsageSnapshot = { inputTokens: 10, outputTokens: 2, metering: {
  knownInputTokens: 10, knownOutputTokens: 2, completeness: "complete", inputIncludesCache: true, raw: {},
} };
function fixture(stops: string[], extra: { maxTurns?: number; tool?: boolean } = {}) {
  const requests: StreamMessageParams[] = [];
  const executed: string[] = [];
  const registry = new ToolRegistry();
  registry.register({ name: "Read", description: "read", inputSchema: {}, execute: async () => {
    executed.push("Read"); return { content: [] };
  } });
  const engine = new QueryEngine({ async *streamMessage(request) {
    requests.push(request);
    yield { type: "text_delta", delta: `part${requests.length}` };
    if (extra.tool && requests.length === 1) yield { type: "tool_use_start", toolUse: { type: "tool_use", id: "partial", name: "Read", input: {}, inputError: { reason: "invalid_json", argumentLength: 4, stopReason: "length" } } };
    yield { type: "usage", usage };
    yield { type: "complete", stopReason: stops[requests.length - 1] ?? "end_turn" };
  } }, registry, { checkTool: async () => ({ action: "allow" }) },
  { execute: async () => ({ blocked: false }) } as never, { trajectoryTrackerFactory: false, maxTurns: extra.maxTurns });
  return { engine, requests, executed };
}
function execution(extra: Partial<AgentExecutionContext> = {}): AgentExecutionContext {
  return { scope: { signal: new AbortController().signal }, emit: async () => {},
    takeSteeredInputs: async () => [], closeSteering() {}, ...extra } as AgentExecutionContext;
}
async function drain(engine: QueryEngine, options: Parameters<QueryEngine["submitMessage"]>[1] = {}) {
  const events: StreamEvent[] = [];
  for await (const event of engine.submitMessage("start", options)) events.push(event);
  return events;
}

describe("bounded output continuation", () => {
  // Catches returning at the first length stop, adding user prompts, or double charging continuation turns.
  it.each(["length", "max_tokens"])("continues %s in the same run with committed segments and real accounting", async stop => {
    const f = fixture([stop, "end_turn"]);
    const events = await drain(f.engine);
    expect(f.requests).toHaveLength(2);
    expect(f.requests[1]?.messages.map(message => message.type)).toEqual(["user", "assistant"]);
    expect(f.requests[1]?.system).toMatch(/continu/i);
    expect(f.engine.getHistory().map(message => message.content)).toEqual(["start", "part1", "part2"]);
    expect(events.filter(event => event.type === "text_delta").map(event => event.delta).join("")).toBe("part1part2");
    expect(f.engine.getTotalUsage().outputTokens).toBe(4);
  });

  it("stops after two automatic continuations and adds one final truncation notice", async () => {
    const f = fixture(["length", "length", "length", "end_turn"]);
    const events = await drain(f.engine);
    expect(f.requests).toHaveLength(3);
    const text = events.filter(event => event.type === "text_delta").map(event => event.delta).join("");
    expect(text.match(/回复已被截断/g)).toHaveLength(1);
    expect(f.engine.getHistory().filter(message => message.type === "assistant").map(message => message.content).slice(0, 2)).toEqual(["part1", "part2"]);
  });

  it("takes new input before continuation, resets its allowance, and keeps steering open between segments", async () => {
    const f = fixture(["length", "length", "length", "end_turn"]);
    let boundaries = 0;
    const closeFlags: boolean[] = [];
    await drain(f.engine, { execution: execution({ takeSteeredInputs: async options => {
      closeFlags.push(options?.closeIfEmpty ?? false);
      return ++boundaries === 2 ? [{ content: "change direction" }] as never : [];
    } }) });
    expect(f.requests).toHaveLength(4);
    expect(closeFlags.slice(0, 3)).toEqual([false, false, false]);
    expect(f.requests[2]?.messages.at(-1)).toEqual({ type: "user", content: "change direction" });
    expect(f.requests[2]?.system ?? "").not.toMatch(/Continue the previous/i);
  });

  it("does not execute tool calls from a truncated response", async () => {
    const f = fixture(["length"], { tool: true });
    await drain(f.engine);
    expect(f.executed).toEqual([]);
    expect(f.engine.getHistory().some(message => message.type === "tool_result" && message.isError)).toBe(true);
  });

  it("keeps the ordinary turn cap and does not overrun the child finalization request", async () => {
    const f = fixture(["length", "length"], { maxTurns: 1 });
    await drain(f.engine);
    expect(f.requests).toHaveLength(1);
    const child = fixture(["length", "length", "length"]);
    await expect(drain(child.engine, { execution: execution({ hardMaxTurns: 2 }) })).rejects.toMatchObject({ name: "MaxTurnsExceeded" });
    expect(child.requests).toHaveLength(2);
    expect(child.requests[1]?.tools).toBeUndefined();
  });

  it.each(["cancel", "budget"] as const)("checks %s before dispatching the next segment", async boundary => {
    const f = fixture(["length", "end_turn"]);
    const controller = new AbortController();
    const failure = new Error(boundary);
    let admissions = 0;
    await expect((async () => {
      for await (const event of f.engine.submitMessage("start", { signal: controller.signal, execution: execution({
        modelAttempts: { beforeDispatch: async () => { if (++admissions === 2 && boundary === "budget") throw failure; }, settle: async () => {} },
      }) })) if (boundary === "cancel" && event.type === "complete") controller.abort(failure);
    })()).rejects.toBe(failure);
    expect(f.requests).toHaveLength(1);
    expect(f.engine.getHistory().at(-1)?.content).toBe("part1");
  });
});

import { describe, expect, it } from "vitest";
import type { StreamMessageParams, UsageSnapshot } from "@vykor/agent-contracts";
import { QueryEngine } from "../query-engine.js";
import { ToolRegistry } from "../tools/tool-registry.js";

function usage(tokens: number, completeness: "complete" | "partial" | "unknown" = "complete"): UsageSnapshot {
  return { inputTokens: tokens, outputTokens: 2, metering: { knownInputTokens: tokens,
    knownOutputTokens: 2, completeness, inputIncludesCache: true, raw: {} } };
}
function fixture(input: { measured?: UsageSnapshot; long?: boolean } = {}) {
  const requests: StreamMessageParams[] = [];
  const registry = new ToolRegistry();
  let configuration = {};
  let generations = 0;
  const client = { async *streamMessage(request: StreamMessageParams) {
    requests.push(request);
    const summary = request.system === "You are a conversation summarizer.";
    if (!summary) generations++;
    yield { type: "text_delta" as const, delta: summary ? "<summary>Prior conversation summarized.</summary>"
      : input.long && generations === 1 ? "a".repeat(30_000) : "answer" };
    if (input.measured && !summary && generations === 1) yield { type: "usage" as const, usage: input.measured };
    yield { type: "complete" as const, stopReason: "end_turn" };
  } };
  const engine = new QueryEngine(client, registry, { checkTool: async () => ({ action: "allow" }) },
    { execute: async () => ({ blocked: false }) } as never, { maxTokens: 50_000, compactKeepRecent: 1,
      trajectoryTrackerFactory: false, resolveRequestConfiguration: async () => ({
        revision: 1, model: "model", client, ...configuration,
      }) });
  const run = async (text = "question") => { for await (const _ of engine.submitMessage(text)) {} };
  return { engine, registry, requests, run, change: (next: object) => { configuration = next; },
    summaryCount: () => requests.filter(request => request.system === "You are a conversation summarizer.").length };
}

describe("measured prefix context compaction", () => {
  // Missing measurement loses the provider's high input count and leaves this history uncompressed.
  it("triggers compaction from a high complete input measurement even when text estimation is small", async () => {
    const f = fixture({ measured: usage(25_000) });
    await f.run();
    await f.run();
    expect(f.summaryCount()).toBe(1);
  });

  // Re-estimating the already measured prefix wrongly compacts on the next request.
  it("adds only new messages to a low measured prefix instead of re-estimating its old text", async () => {
    const f = fixture({ measured: usage(10), long: true });
    await f.run("a".repeat(30_000));
    await f.run();
    expect(f.summaryCount()).toBe(0);
  });

  it.each([undefined, usage(25_000, "partial"), usage(25_000, "unknown"), { ...usage(25_000), usageIncomplete: true }])(
    "does not trust missing or incomplete usage %j", async measured => {
      const f = fixture({ measured }); await f.run(); await f.run();
      expect(f.summaryCount()).toBe(0);
    });

  it.each([{ model: "other" }, { provider: "other" }, { systemPrompt: "changed" },
    { maxOutputTokens: 2048 }, { reasoningEffort: "high" }, { effort: "high" }, { supportsImageInput: false }])(
    "falls back when request input configuration changes %j", async configuration => {
      const f = fixture({ measured: usage(25_000) }); await f.run(); f.change(configuration); await f.run();
      expect(f.summaryCount()).toBe(0);
    });

  it("invalidates the prefix when exposed tool definitions change", async () => {
    const f = fixture({ measured: usage(25_000) }); await f.run();
    f.registry.register({ name: "Read", description: "read", inputSchema: {}, execute: async () => ({ content: [] }) });
    await f.run(); expect(f.summaryCount()).toBe(0);
  });

  it("invalidates on restored history even if the restored values equal the measured prefix", async () => {
    const f = fixture({ measured: usage(25_000) }); await f.run();
    f.engine.loadMessages(f.engine.getHistory());
    await f.run(); expect(f.summaryCount()).toBe(0);
  });

  it("does not reuse the old measurement after history compaction replaces the prefix", async () => {
    const f = fixture({ measured: usage(25_000) }); await f.run();
    await f.run();
    expect(f.summaryCount()).toBe(1);
    expect(f.engine.getHistory().some(message => message.type === "assistant" && message.compactRole === "summary")).toBe(true);
    await f.run(); expect(f.summaryCount()).toBe(1);
  });
});

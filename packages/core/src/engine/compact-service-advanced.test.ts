import { describe, it, expect, vi } from "vitest";
import {
  CompactService,
  isPromptTooLongError,
  type CompactClient,
  type CompactProgressEvent,
} from "./compact-service.js";
import type { Message, StreamEvent, IHookExecutor, HookResult } from "../index.js";

it("counts replayable reasoning but not display-only think text", () => {
  const service = new CompactService();
  const base: Message = { type: "assistant", content: "answer" };
  const baseline = service.estimateTokens([base]);
  const thinkOnly = service.estimateTokens([{ ...base, reasoning: "x".repeat(4000) }]);
  const replay = service.estimateTokens([{
    ...base,
    reasoning: "x".repeat(8000),
    reasoningReplay: "x".repeat(4000),
  }]);
  expect(thinkOnly).toBe(baseline);
  expect(replay).toBeGreaterThan(baseline + 500);
});

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** A summarizer client that yields a fixed summary, and records the prompt. */
function makeSummaryClient(summary: string): CompactClient & { lastPrompt: string } {
  const client: any = {
    lastPrompt: "",
    submitMessage: async function* (content: string): AsyncIterable<StreamEvent> {
      client.lastPrompt = content;
      yield { type: "text_delta", delta: summary };
      yield { type: "complete", stopReason: "end_turn" };
    },
  };
  return client;
}

/**
 * A summarizer client that throws a PTL error the first `failTimes` calls, then
 * succeeds. Records each prompt it received so tests can assert head truncation.
 */
function makePtlClient(
  failTimes: number,
  summary: string,
): CompactClient & { prompts: string[]; calls: number } {
  const client: any = {
    prompts: [] as string[],
    calls: 0,
    submitMessage: async function* (content: string): AsyncIterable<StreamEvent> {
      client.calls++;
      client.prompts.push(content);
      if (client.calls <= failTimes) {
        throw new Error("the input exceeds the available context size of the model");
      }
      yield { type: "text_delta", delta: summary };
      yield { type: "complete", stopReason: "end_turn" };
    },
  };
  return client;
}

function makeHookExecutor(
  result: HookResult = { blocked: false },
): IHookExecutor & { calls: { event: string; ctx: Record<string, unknown> }[] } {
  const exec: any = {
    calls: [] as { event: string; ctx: Record<string, unknown> }[],
    register: () => {},
    execute: async (event: string, ctx: Record<string, unknown>) => {
      exec.calls.push({ event, ctx });
      return result;
    },
  };
  return exec;
}

/** Build a long conversation that exceeds a small token budget. */
function bigConversation(turns: number): Message[] {
  const msgs: Message[] = [];
  for (let i = 0; i < turns; i++) {
    msgs.push({ type: "user", content: `User question ${i} ${"x".repeat(200)}` });
    msgs.push({ type: "assistant", content: `Assistant reply ${i} ${"y".repeat(200)}` });
  }
  return msgs;
}

const SMALL_MAX = 20_000 + 13_000 + 100; // threshold ~= 100 tokens

// ---------------------------------------------------------------------------
// 0. microCompact tool-result clearing policy
// ---------------------------------------------------------------------------

describe("microCompact clearing policy", () => {
  it("clears old results for compactable (known) tools", () => {
    const svc = new CompactService(100_000, 1);
    const msgs: Message[] = [];
    for (let i = 0; i < 4; i++) {
      msgs.push({
        type: "assistant",
        content: "",
        toolUses: [{ type: "tool_use", id: `b${i}`, name: "Bash", input: {} }],
      });
      msgs.push({
        type: "tool_result",
        toolUseId: `b${i}`,
        content: [{ type: "text", text: `output ${i}` }],
      });
    }
    const result = svc.microCompact(msgs);
    // keepRecent=1 → the oldest Bash results are cleared, most recent retained.
    const clearedCount = result.filter(
      (m) =>
        m.type === "tool_result" &&
        m.content.length === 1 &&
        (m.content[0] as { text: string }).text === "[Old tool result content cleared]",
    ).length;
    expect(clearedCount).toBeGreaterThan(0);
  });

  it("does NOT clear results for unknown / unmatched tool names", () => {
    const svc = new CompactService(100_000, 1);
    // Tool results whose tool_use has an unknown name, and orphaned results
    // (no matching tool_use at all). Both must be retained verbatim.
    const msgs: Message[] = [
      {
        type: "assistant",
        content: "",
        toolUses: [{ type: "tool_use", id: "u1", name: "CustomMcpThing", input: {} }],
      },
      { type: "tool_result", toolUseId: "u1", content: [{ type: "text", text: "keep me 1" }] },
      {
        type: "assistant",
        content: "",
        toolUses: [{ type: "tool_use", id: "u2", name: "CustomMcpThing", input: {} }],
      },
      { type: "tool_result", toolUseId: "u2", content: [{ type: "text", text: "keep me 2" }] },
      // Orphaned result — no tool_use emitted its id (name resolves to "").
      { type: "tool_result", toolUseId: "orphan", content: [{ type: "text", text: "keep orphan" }] },
    ];
    const result = svc.microCompact(msgs);
    // Nothing cleared: all original texts survive.
    const texts = result
      .filter((m) => m.type === "tool_result")
      .map((m) => (m as { content: { text: string }[] }).content[0]!.text);
    expect(texts).toEqual(["keep me 1", "keep me 2", "keep orphan"]);
    expect(texts).not.toContain("[Old tool result content cleared]");
  });
});

// ---------------------------------------------------------------------------
// 1. PTL error detection + head-truncation retry
// ---------------------------------------------------------------------------

describe("PTL detection", () => {
  it("recognizes llama.cpp / OpenAI context-overflow errors", () => {
    expect(isPromptTooLongError(new Error("prompt too long for the model"))).toBe(true);
    expect(isPromptTooLongError(new Error("context_length_exceeded"))).toBe(true);
    expect(isPromptTooLongError(new Error("exceeds the available context size"))).toBe(true);
    expect(isPromptTooLongError(new Error("some unrelated failure"))).toBe(false);
  });
});

describe("PTL head-truncation retry", () => {
  it("retries with older context trimmed when the summarizer reports overflow", async () => {
    const client = makePtlClient(1, "<summary>recovered after truncation</summary>");
    const svc = new CompactService(SMALL_MAX, 2, { client });
    const result = await svc.autoCompact(bigConversation(15));

    // Summarizer was called twice: first failed (PTL), retry succeeded.
    expect(client.calls).toBe(2);
    // The retried prompt should be shorter than the first (head truncated).
    expect(client.prompts[1]!.length).toBeLessThan(client.prompts[0]!.length);
    // Summary made it into the compacted history.
    expect(result.some((m) => m.type === "assistant" && m.content.includes("recovered"))).toBe(true);
  });

  it("truncateHeadForPtlRetry drops oldest rounds and inserts a retry marker", () => {
    const svc = new CompactService();
    const messages: Message[] = [
      { type: "user", content: "round one" },
      { type: "assistant", content: "reply one" },
      { type: "user", content: "round two" },
      { type: "assistant", content: "reply two" },
      { type: "user", content: "round three" },
      { type: "assistant", content: "reply three" },
      { type: "user", content: "round four" },
      { type: "assistant", content: "reply four" },
      { type: "user", content: "round five" },
      { type: "assistant", content: "reply five" },
    ];
    const truncated = svc.truncateHeadForPtlRetry(messages);
    expect(truncated).not.toBeNull();
    expect(truncated!.length).toBeLessThan(messages.length);
    // First round ("round one") should be gone.
    expect(truncated!.some((m) => m.type === "user" && m.content === "round one")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. tool_use / tool_result pairing protection
// ---------------------------------------------------------------------------

describe("tool pairing protection", () => {
  it("does not split a tool_use from its tool_result at the preserve boundary", () => {
    const svc = new CompactService(100_000, 2);
    // keepRecent=2 would naively cut between the assistant tool_use and its
    // tool_result; the split must walk back to keep them together.
    const messages: Message[] = [
      { type: "user", content: "do something" },
      { type: "assistant", content: "", toolUses: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
      { type: "tool_result", toolUseId: "t1", content: [{ type: "text", text: "output" }] },
    ];
    const { older, recent } = svc.splitPreservingToolPairs(messages);

    // The tool_use (assistant) and tool_result must end up on the same side.
    const assistantInRecent = recent.some(
      (m) => m.type === "assistant" && m.toolUses?.some((t) => t.id === "t1"),
    );
    const resultInRecent = recent.some(
      (m) => m.type === "tool_result" && m.toolUseId === "t1",
    );
    expect(assistantInRecent).toBe(resultInRecent);
    // And the older segment must not contain the orphaned tool_use.
    const assistantInOlder = older.some(
      (m) => m.type === "assistant" && m.toolUses?.some((t) => t.id === "t1"),
    );
    const resultInOlder = older.some(
      (m) => m.type === "tool_result" && m.toolUseId === "t1",
    );
    expect(assistantInOlder).toBe(resultInOlder);
  });

  it("does not split sibling tool_results from the same assistant tool call group", () => {
    const svc = new CompactService(100_000, 1);
    const messages: Message[] = [
      { type: "user", content: "run commands" },
      {
        type: "assistant",
        content: "",
        toolUses: [
          { type: "tool_use", id: "t1", name: "Bash", input: { command: "pwd" } },
          { type: "tool_use", id: "t2", name: "Bash", input: { command: "hostname" } },
        ],
      },
      { type: "tool_result", toolUseId: "t1", content: [{ type: "text", text: "cwd" }] },
      { type: "tool_result", toolUseId: "t2", content: [{ type: "text", text: "host" }] },
    ];

    const { older, recent } = svc.splitPreservingToolPairs(messages);

    expect(older).toHaveLength(1);
    expect(recent).toEqual(messages.slice(1));
  });
});

// ---------------------------------------------------------------------------
// 3. Image token accounting + summarizer placeholder
// ---------------------------------------------------------------------------

describe("image handling", () => {
  it("counts image blocks in token estimation", () => {
    const svc = new CompactService(100_000, 10, { imageTokenEstimate: 3000 });
    const withImage: Message[] = [
      {
        type: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image", source: { type: "file", mediaType: "image/png", path: "/tmp/compact-image.png" } },
        ],
      },
    ];
    const withoutImage: Message[] = [
      { type: "user", content: [{ type: "text", text: "look" }] },
    ];
    expect(svc.estimateTokens(withImage)).toBeGreaterThan(
      svc.estimateTokens(withoutImage) + 2000,
    );
  });

  it("uses prepared image dimensions instead of the fallback image estimate", () => {
    const svc = new CompactService(100_000, 10, { imageTokenEstimate: 3000 });
    const prepared: Message[] = [{
      type: "user",
      content: [{
        type: "image",
        source: {
          type: "file",
          mediaType: "image/png",
          path: "/tmp/prepared-image.png",
          prepared: {
            mediaType: "image/jpeg",
            width: 280,
            height: 280,
            base64Bytes: 1024,
            policyVersion: "vision-v1",
          },
        },
      }],
    }];
    const fallback: Message[] = [{
      type: "user",
      content: [{
        type: "image",
        source: {
          type: "file",
          mediaType: "image/png",
          path: "/tmp/unprepared-image.png",
        },
      }],
    }];

    expect(svc.estimateTokens(prepared)).toBe(134);
    expect(svc.estimateTokens(prepared)).toBeLessThan(svc.estimateTokens(fallback));
  });

  it("replaces image payloads with placeholders for the summarizer request", () => {
    const svc = new CompactService();
    const messages: Message[] = [
      {
        type: "user",
        content: [
          { type: "text", text: "screenshot:" },
          { type: "image", source: { type: "file", mediaType: "image/png", path: "/tmp/huge-payload.png" } },
        ],
      },
    ];
    const replaced = svc.replaceImagesWithPlaceholders(messages);
    const block = (replaced[0] as { content: any[] }).content;
    expect(block.some((b: any) => b.type === "image")).toBe(false);
    expect(block.some((b: any) => b.type === "text" && /Image omitted/.test(b.text))).toBe(true);
  });

  it("does not ship raw image data to the summarizer during compaction", async () => {
    const client = makeSummaryClient("<summary>ok</summary>");
    const svc = new CompactService(SMALL_MAX, 2, { client });
    const messages: Message[] = [
      ...bigConversation(10),
      {
        type: "user",
        content: [
          { type: "text", text: "here is an image" },
          { type: "image", source: { type: "file", mediaType: "image/png", path: "/tmp/secret-image.png" } },
        ],
      },
      { type: "assistant", content: "got it" },
    ];
    await svc.autoCompact(messages);
    expect(client.lastPrompt).not.toContain("SECRETIMAGEDATA12345");
  });
});

// ---------------------------------------------------------------------------
// 4. compact supplemental context
// ---------------------------------------------------------------------------

describe("compact supplemental context", () => {
  it("includes provider session memory in the summarizer prompt", async () => {
    const client = makeSummaryClient("<summary>ok</summary>");
    const svc = new CompactService(SMALL_MAX, 2, {
      client,
      contextProvider: () => ({
        sessionMemory: "remember the current checkpoint",
        taskFocus: "finish compact docs",
      }),
    });

    await svc.autoCompact(bigConversation(15));

    expect(client.lastPrompt).toContain("## Session Memory Checkpoint");
    expect(client.lastPrompt).toContain("remember the current checkpoint");
    expect(client.lastPrompt).toContain("## Current Task");
    expect(client.lastPrompt).toContain("finish compact docs");
  });

  it("includes provider-defined supplemental sections without knowing their schema", async () => {
    const client = makeSummaryClient("<summary>ok</summary>");
    const svc = new CompactService(SMALL_MAX, 2, {
      client,
      contextProvider: () => ({
        supplementalSections: [{
          heading: "Business Context",
          content: "- ticket: OPS-42",
        }],
      }),
    });

    await svc.autoCompact(bigConversation(15));

    expect(client.lastPrompt).toContain("## Business Context");
    expect(client.lastPrompt).toContain("- ticket: OPS-42");
  });

  it("bounds and normalizes provider-defined supplemental sections", async () => {
    const client = makeSummaryClient("<summary>ok</summary>");
    const svc = new CompactService(SMALL_MAX, 2, {
      client,
      contextProvider: () => ({
        supplementalSections: [
          { heading: "", content: "ignored empty heading" },
          { heading: "ignored empty content", content: "" },
          {
            heading: `first\r\n${"h".repeat(200)}`,
            content: "甲".repeat(20_000),
          },
          { heading: "second", content: "乙".repeat(20_000) },
          ...Array.from({ length: 8 }, (_, index) => ({
            heading: `extra-${index}`,
            content: `value-${index}`,
          })),
        ],
      }),
    });

    await svc.autoCompact(bigConversation(15));

    expect(client.lastPrompt).toContain(`## ${`first ${"h".repeat(114)}`}`);
    expect(client.lastPrompt).not.toContain("ignored empty heading");
    expect(client.lastPrompt).not.toContain("ignored empty content");
    expect((client.lastPrompt.match(/甲/g) ?? [])).toHaveLength(16_000);
    expect((client.lastPrompt.match(/乙/g) ?? [])).toHaveLength(16_000);
    expect(client.lastPrompt).not.toContain("extra-6");
  });

  it("rejects compact when the context provider fails and preserves its cause", async () => {
    const client = makeSummaryClient("<summary>must not be used</summary>");
    const providerError = new Error("session memory unavailable");
    const svc = new CompactService(SMALL_MAX, 2, {
      client,
      contextProvider: async () => {
        throw providerError;
      },
    });

    const failure = await svc.autoCompact(bigConversation(15)).catch((error) => error);

    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBe(providerError);
    expect((failure as Error).cause).toBe(providerError);
    expect(client.lastPrompt).toBe("");
  });
});

// ---------------------------------------------------------------------------
// 5. context collapse — deterministic shrink of oversized text
// ---------------------------------------------------------------------------

describe("context collapse", () => {
  it("collapses oversized text blocks without a model call", () => {
    const svc = new CompactService(100_000, 2);
    const huge = "Z".repeat(10_000);
    const messages: Message[] = [
      { type: "user", content: `intro ${huge}` },
      { type: "assistant", content: `reply ${huge}` },
      { type: "user", content: "first recent" },
      { type: "assistant", content: "second recent" },
      { type: "user", content: "third recent" },
    ];
    const collapsed = svc.tryContextCollapse(messages);
    expect(collapsed).not.toBeNull();
    expect(svc.estimateTokens(collapsed!)).toBeLessThan(svc.estimateTokens(messages));
    // Recent messages stay verbatim.
    expect(collapsed!.some((m) => m.type === "user" && m.content === "third recent")).toBe(true);
    // Collapsed marker present in the older portion.
    const collapsedText = collapsed!
      .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
      .join("");
    expect(collapsedText).toContain("collapsed");
  });

  it("returns null when nothing is oversized", () => {
    const svc = new CompactService(100_000, 2);
    const messages: Message[] = [
      { type: "user", content: "tiny" },
      { type: "assistant", content: "tiny" },
      { type: "user", content: "tiny" },
      { type: "assistant", content: "tiny" },
      { type: "user", content: "tiny" },
    ];
    expect(svc.tryContextCollapse(messages)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 6. boundary marker insertion
// ---------------------------------------------------------------------------

describe("boundary marker", () => {
  it("inserts a boundary marker between summarized history and preserved messages", async () => {
    const client = makeSummaryClient("<summary>the gist</summary>");
    const svc = new CompactService(SMALL_MAX, 2, { client });
    const result = await svc.autoCompact(bigConversation(15));
    const hasBoundary = result.some(
      (m) =>
        (typeof m.content === "string" ? m.content : "").includes("[Compact boundary marker]"),
    );
    expect(hasBoundary).toBe(true);
  });

  it("simpleCompact (no client) also inserts a boundary marker", () => {
    const svc = new CompactService(100_000, 2);
    const result = svc.simpleCompact(bigConversation(10));
    const hasBoundary = result.some(
      (m) => (typeof m.content === "string" ? m.content : "").includes("[Compact boundary marker]"),
    );
    expect(hasBoundary).toBe(true);

    const summary = result.find(
      (m) =>
        m.type === "assistant" &&
        (typeof m.content === "string" ? m.content : "").includes("[Conversation compacted"),
    );
    expect(summary?.compactRole).toBe("summary");

    const boundary = result.find(
      (m) =>
        m.type === "user" &&
        (typeof m.content === "string" ? m.content : "").includes("[Compact boundary marker]"),
    );
    expect(boundary?.compactRole).toBe("boundary");
  });
});

// ---------------------------------------------------------------------------
// 7. PRE/POST_COMPACT hooks
// ---------------------------------------------------------------------------

describe("pre/post compact hooks", () => {
  it("fires pre_compact and post_compact around a full compaction", async () => {
    const client = makeSummaryClient("<summary>done</summary>");
    const hooks = makeHookExecutor();
    const svc = new CompactService(SMALL_MAX, 2, { client, hookExecutor: hooks });
    await svc.autoCompact(bigConversation(15));

    const events = hooks.calls.map((c) => c.event);
    expect(events).toContain("pre_compact");
    expect(events).toContain("post_compact");
    expect(events.indexOf("pre_compact")).toBeLessThan(events.indexOf("post_compact"));
  });

  it("a blocking pre_compact hook prevents compaction (messages unchanged)", async () => {
    const client = makeSummaryClient("<summary>should not be used</summary>");
    const hooks = makeHookExecutor({ blocked: true, reason: "user opted out" });
    const svc = new CompactService(SMALL_MAX, 2, { client, hookExecutor: hooks });
    const input = bigConversation(15);
    const result = await svc.autoCompact(input);

    // Summarizer must not have produced a summary message.
    expect(result.some((m) => m.type === "assistant" && m.content.includes("should not be used"))).toBe(false);
    // post_compact should not fire when blocked.
    expect(hooks.calls.map((c) => c.event)).not.toContain("post_compact");
  });

  it("works without a hook executor (no crash)", async () => {
    const client = makeSummaryClient("<summary>fine</summary>");
    const svc = new CompactService(SMALL_MAX, 2, { client });
    const result = await svc.autoCompact(bigConversation(15));
    expect(result.length).toBeLessThan(bigConversation(15).length);
  });
});

// ---------------------------------------------------------------------------
// 8. progress callback + checkpoints
// ---------------------------------------------------------------------------

describe("progress callback and checkpoints", () => {
  it("emits compact_start and compact_end progress events", async () => {
    const client = makeSummaryClient("<summary>progress</summary>");
    const events: CompactProgressEvent[] = [];
    const svc = new CompactService(SMALL_MAX, 2, {
      client,
      progressCallback: (e) => {
        events.push(e);
      },
    });
    await svc.autoCompact(bigConversation(15));
    const phases = events.map((e) => e.phase);
    expect(phases).toContain("compact_start");
    expect(phases).toContain("compact_end");
  });

  it("records checkpoints retrievable via getCheckpoints", async () => {
    const client = makeSummaryClient("<summary>cp</summary>");
    const svc = new CompactService(SMALL_MAX, 2, { client });
    await svc.autoCompact(bigConversation(15));
    const checkpoints = svc.getCheckpoints().map((c) => c.checkpoint);
    expect(checkpoints).toContain("compact_start");
    expect(checkpoints).toContain("compact_end");
  });
});

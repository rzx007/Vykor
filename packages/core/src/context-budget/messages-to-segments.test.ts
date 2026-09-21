import { describe, expect, it } from "vitest";

import { messagesToLedgerSegments } from "./messages-to-segments.js";

describe("messagesToLedgerSegments", () => {
  it("includes replayable reasoning without counting display-only think text", () => {
    const segments = messagesToLedgerSegments([{
      type: "assistant",
      content: "answer",
      reasoning: "think and replay",
      reasoningReplay: "replay",
    }]);
    expect(segments[0]?.text).toBe("answerreplay");
  });
  it("routes compactRole summary to summary bucket and boundary to conversation", () => {
    const segments = messagesToLedgerSegments([
      { type: "assistant", content: "Summary: did stuff", compactRole: "summary" },
      { type: "user", content: "[Compact boundary marker]\n...", compactRole: "boundary" },
      { type: "user", content: "continue please" },
    ]);
    expect(segments.filter((s) => s.bucket === "summary")).toHaveLength(1);
    expect(segments.filter((s) => s.bucket === "conversation").length).toBeGreaterThanOrEqual(2);
  });

  it("uses heuristic for unmarked legacy compact pair", () => {
    const segments = messagesToLedgerSegments([
      {
        type: "assistant",
        content:
          "[Conversation compacted: 3 messages summarized (1 tool results removed). 2 recent messages preserved.]",
      },
      {
        type: "user",
        content: "[Compact boundary marker]\nEarlier conversation was compacted.",
      },
    ]);
    expect(segments.some((s) => s.bucket === "summary")).toBe(true);
  });

  it("does not classify a compact-looking assistant message without a following boundary", () => {
    const segments = messagesToLedgerSegments([
      {
        type: "assistant",
        content:
          "[Conversation compacted: this is ordinary model output, not an actual compact summary]",
      },
      { type: "user", content: "continue without a compact boundary" },
    ]);

    expect(segments.some((s) => s.bucket === "summary")).toBe(false);
    expect(segments[0]?.bucket).toBe("conversation");
  });

  it("counts image blocks with 3072 mediaTokens", () => {
    const segments = messagesToLedgerSegments([
      {
        type: "user",
        content: [
          { type: "text", text: "see" },
          {
            type: "image",
            source: { type: "file", mediaType: "image/png", path: "/x.png" },
          },
        ],
      },
    ]);
    expect(segments.find((s) => s.bucket === "conversation")?.mediaTokens).toBe(3072);
  });
});

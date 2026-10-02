import { describe, expect, it } from "vitest";
import { applyToolOutputBudget } from "./query-tool-limits.js";

const ref = "[tool-output-ref: opaque://abc]";
const text = (content: ReturnType<typeof applyToolOutputBudget>) => content.filter((block) => block.type === "text").map((block) => block.text).join("");

describe("tool output history budget", () => {
  it("keeps one bounded independent reference and an accurate notice at a block boundary", () => {
    const before = process.env.VYKOR_TOOL_OUTPUT_INLINE_CHARS;
    const previewBefore = process.env.VYKOR_TOOL_OUTPUT_PREVIEW_CHARS;
    process.env.VYKOR_TOOL_OUTPUT_INLINE_CHARS = "256";
    process.env.VYKOR_TOOL_OUTPUT_PREVIEW_CHARS = "128";
    try {
      const image = { type: "image" as const, source: { type: "base64" as const, mediaType: "image/png", data: "AA==" } };
      const content = [
        { type: "text" as const, text: "a".repeat(128) }, image,
        { type: "text" as const, text: "b".repeat(300) },
        { type: "text" as const, text: ref },
        { type: "text" as const, text: ref },
      ];
      const once = applyToolOutputBudget(content);
      expect(once).toContain(image);
      expect(once.filter((block) => block.type === "text" && block.text === ref)).toHaveLength(1);
      expect(text(once)).toContain("输出已截断");
      expect(text(once)).not.toContain("b".repeat(100));
      const again = applyToolOutputBudget(once);
      expect(again.filter((block) => block.type === "text" && block.text === ref)).toHaveLength(1);
    } finally {
      if (before === undefined) delete process.env.VYKOR_TOOL_OUTPUT_INLINE_CHARS;
      else process.env.VYKOR_TOOL_OUTPUT_INLINE_CHARS = before;
      if (previewBefore === undefined) delete process.env.VYKOR_TOOL_OUTPUT_PREVIEW_CHARS;
      else process.env.VYKOR_TOOL_OUTPUT_PREVIEW_CHARS = previewBefore;
    }
  });

  it("does not protect malformed, whitespace, or oversized reference blocks", () => {
    const content = [
      { type: "text" as const, text: "x".repeat(20000) },
      { type: "text" as const, text: "[tool-output-ref: has space]" },
      { type: "text" as const, text: `[tool-output-ref: ${"q".repeat(100)}]` },
    ];
    const result = applyToolOutputBudget(content);
    expect(text(result)).not.toContain("tool-output-ref");
  });
});

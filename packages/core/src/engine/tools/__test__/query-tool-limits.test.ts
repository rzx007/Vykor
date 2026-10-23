import { describe, expect, it } from "vitest";
import { applyToolOutputBudget } from "../query-tool-limits.js";

const ref = "[tool-output-ref: opaque://abc]";
const text = (content: ReturnType<typeof applyToolOutputBudget>) => content.filter((block) => block.type === "text").map((block) => block.text).join("");

describe("tool output history budget", () => {
  it("keeps one bounded independent reference and an accurate notice at a block boundary", () => {
    const policy = { inlineChars: 256, previewChars: 128 };

      const image = { type: "image" as const, source: { type: "base64" as const, mediaType: "image/png", data: "AA==" } };
      const content = [
        { type: "text" as const, text: "a".repeat(128) }, image,
        { type: "text" as const, text: "b".repeat(300) },
        { type: "text" as const, text: ref },
        { type: "text" as const, text: ref },
      ];
      const once = applyToolOutputBudget(content, policy);
      expect(once).toContain(image);
      expect(once.filter((block) => block.type === "text" && block.text === ref)).toHaveLength(1);
      expect(text(once)).toContain("输出已截断");
      expect(text(once)).not.toContain("b".repeat(100));
      const again = applyToolOutputBudget(once, policy);
      expect(again.filter((block) => block.type === "text" && block.text === ref)).toHaveLength(1);

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

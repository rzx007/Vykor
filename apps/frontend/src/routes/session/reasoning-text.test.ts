import { expect, test } from "bun:test";

import { REASONING_DISPLAY_LIMIT, truncateReasoning } from "./reasoning-text";

test("keeps short reasoning text unchanged", () => {
  expect(truncateReasoning("先看文件。")).toEqual({ text: "先看文件。", omitted: 0 });
});

test("keeps the tail and counts the omitted characters once over the limit", () => {
  const text = `开头${"x".repeat(REASONING_DISPLAY_LIMIT)}结尾`;

  const truncated = truncateReasoning(text);

  expect(truncated.text).not.toContain("开头");
  expect(truncated.text.endsWith("结尾")).toBe(true);
  expect(truncated.text).toHaveLength(REASONING_DISPLAY_LIMIT);
  expect(truncated.omitted).toBe(4);
});

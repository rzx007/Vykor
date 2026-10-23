import { describe, expect, it } from "vitest";

import { formatSessionTitle, isPlaceholderSessionTitle } from "../title.js";

describe("formatSessionTitle", () => {
  it("takes the first sentence and caps at 20 chars", () => {
    expect(formatSessionTitle("你好世界，这是一段很长的开场白用来测试截断。后面还有。")).toBe(
      "你好世界，这是一段很长的开场白用来测试截",
    );
    expect(formatSessionTitle("Hello world. More text.")).toBe("Hello world.");
    expect(formatSessionTitle("abcdefghijklmnopqrstuvwxyz")).toBe("abcdefghijklmnopqrst");
  });

  it("collapses whitespace", () => {
    expect(formatSessionTitle("  one\n\ntwo  ")).toBe("one two");
  });
});

describe("isPlaceholderSessionTitle", () => {
  it("treats empty and TUI as placeholders", () => {
    expect(isPlaceholderSessionTitle("")).toBe(true);
    expect(isPlaceholderSessionTitle("TUI")).toBe(true);
    expect(isPlaceholderSessionTitle("Scratch")).toBe(false);
  });
});

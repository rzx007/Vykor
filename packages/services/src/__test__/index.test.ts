import { describe, it, expect } from "vitest";
import { estimateTokens } from "../token-estimation/index.js";

describe("estimateTokens", () => {
  it("estimates tokens as char/4", () => {
    const result = estimateTokens("hello world", "gpt-4");
    expect(result.tokens).toBe(3);
    expect(result.model).toBe("gpt-4");
  });

  it("uses default model", () => {
    const result = estimateTokens("test");
    expect(result.model).toBe("gpt-4");
  });

  it("handles empty string", () => {
    const result = estimateTokens("");
    expect(result.tokens).toBe(0);
  });
});

import { describe, expect, it } from "vitest";

import { evaluateTips } from "../tips.js";

describe("evaluateTips", () => {
  it("returns only no_context_window when contextWindow is null", () => {
    const tips = evaluateTips({
      estimatedInputTokens: 50_000,
      contextWindow: null,
      toolsTokens: 10_000,
      mcpTokens: 10_000,
      modelSwitch: { previousContextWindow: 200_000 },
    });
    expect(tips.map((t) => t.code)).toEqual(["no_context_window"]);
  });

  it("emits near_full when padded total reaches 85% of the window", () => {
    // paddedTotal = ceil(estimated * 4/3); need >= 0.85 * window
    const contextWindow = 100_000;
    const estimatedInputTokens = Math.ceil(contextWindow * 0.85 * 0.75);
    const tips = evaluateTips({
      estimatedInputTokens,
      contextWindow,
      toolsTokens: 0,
      mcpTokens: 0,
    });
    expect(tips.some((t) => t.code === "near_full")).toBe(true);
  });

  it("does not emit near_full just below the 85% padded threshold", () => {
    const contextWindow = 100_000;
    // Keep padded total strictly below 85% of window.
    const estimatedInputTokens = Math.floor(contextWindow * 0.85 * 0.75) - 10;
    const tips = evaluateTips({
      estimatedInputTokens,
      contextWindow,
      toolsTokens: 0,
      mcpTokens: 0,
    });
    expect(tips.some((t) => t.code === "near_full")).toBe(false);
  });

  it("emits static_tools_heavy when tools+mcp share >= 20% of window", () => {
    const tips = evaluateTips({
      estimatedInputTokens: 1_000,
      contextWindow: 100_000,
      toolsTokens: 15_000,
      mcpTokens: 5_000,
    });
    expect(tips.some((t) => t.code === "static_tools_heavy")).toBe(true);
  });
});

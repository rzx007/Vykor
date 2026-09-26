import { describe, expect, it } from "vitest";

import { CostTracker } from "./cost-tracker.js";

describe("CostTracker usage completeness", () => {
  it("keeps known totals and marks incompleteness after an unknown attempt", () => {
    const tracker = new CostTracker();
    tracker.markUsageIncomplete();
    tracker.addUsage({ inputTokens: 100, outputTokens: 20 });
    expect(tracker.getTotal()).toMatchObject({
      inputTokens: 100,
      outputTokens: 20,
      usageIncomplete: true,
    });
    tracker.addUsage({ inputTokens: 5, outputTokens: 1 });
    expect(tracker.getTotal()).toMatchObject({
      inputTokens: 105,
      outputTokens: 21,
      usageIncomplete: true,
    });
  });

  it("does not clear incompleteness after later known usage", () => {
    const tracker = new CostTracker();
    tracker.markUsageIncomplete();
    tracker.addUsage({ inputTokens: 1, outputTokens: 1, usageIncomplete: false });
    expect(tracker.getTotal().usageIncomplete).toBe(true);
  });

  it("resets the incompleteness flag with reset()", () => {
    const tracker = new CostTracker();
    tracker.markUsageIncomplete();
    tracker.reset();
    expect(tracker.getTotal().usageIncomplete).toBeUndefined();
    expect(tracker.getTotal()).toMatchObject({ inputTokens: 0, outputTokens: 0 });
  });

  it("only counts the snapshots the engine passes (latest per attempt)", () => {
    const tracker = new CostTracker();
    tracker.addUsage({ inputTokens: 15, outputTokens: 3 });
    expect(tracker.getTotal()).toMatchObject({ inputTokens: 15, outputTokens: 3 });
  });
});

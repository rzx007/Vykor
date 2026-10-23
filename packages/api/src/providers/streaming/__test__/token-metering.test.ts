import { describe, expect, it } from "vitest";
import { normalizeTokenMetering } from "../token-metering.js";

describe("normalizeTokenMetering", () => {
  it("adds separate cache components but never counts included cache twice", () => {
    expect(normalizeTokenMetering({ input: 10, output: 2, cacheCreation: 3, cacheRead: 5 }, false, true))
      .toMatchObject({ knownInputTokens: 18, knownOutputTokens: 2, completeness: "complete", inputIncludesCache: false });
    expect(normalizeTokenMetering({ input: 18, output: 2, cacheRead: 5 }, true, true))
      .toMatchObject({ knownInputTokens: 18, knownOutputTokens: 2, completeness: "complete" });
  });
  it("distinguishes zero, missing, invalid, and non-final counts", () => {
    expect(normalizeTokenMetering({ input: 0, output: 0 }, true, true).completeness).toBe("complete");
    expect(normalizeTokenMetering({ input: undefined, output: 2 }, true, true).completeness).toBe("partial");
    expect(normalizeTokenMetering({ input: 3, output: 2 }, false, true).completeness).toBe("partial");
    expect(normalizeTokenMetering({ input: 3, output: 2 }, true, false).completeness).toBe("partial");
    expect(normalizeTokenMetering({ input: -1, output: NaN }, true, true).completeness).toBe("unknown");
  });
  it("keeps only provable safe components when separate input counts overflow", () => {
    expect(normalizeTokenMetering({ input: Number.MAX_SAFE_INTEGER, output: 2, cacheCreation: 1, cacheRead: 0 }, false, true))
      .toMatchObject({ knownInputTokens: Number.MAX_SAFE_INTEGER, knownOutputTokens: 2, completeness: "partial" });
    expect(normalizeTokenMetering({ input: Number.MAX_SAFE_INTEGER, output: 1 }, true, true))
      .toMatchObject({ knownInputTokens: Number.MAX_SAFE_INTEGER, knownOutputTokens: 1, completeness: "partial" });
  });
});

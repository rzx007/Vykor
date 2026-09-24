import { describe, expect, it } from "vitest";

import { assembleContextUsageSnapshot } from "@vykor/core";

import { ContextUsageCache } from "./context-usage-cache.js";

describe("ContextUsageCache", () => {
  it("stores and returns snapshots by sessionId", () => {
    const cache = new ContextUsageCache();
    const snapshot = assembleContextUsageSnapshot({
      segments: [{ bucket: "conversation", text: "hi" }],
      model: "m",
      contextWindow: 1000,
      source: "live_assembly",
    });

    cache.set("s1", snapshot);
    expect(cache.get("s1")).toEqual(snapshot);

    cache.invalidate("s1");
    expect(cache.get("s1")).toBeUndefined();
  });
});

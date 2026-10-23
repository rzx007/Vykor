import { describe, expect, it } from "vitest";

import { assembleContextUsageSnapshot } from "../assemble.js";
import type { ContextLedgerSegment } from "@vykor/agent-contracts";

describe("assembleContextUsageSnapshot", () => {
  it("puts tool schema in tools and tool result text in conversation", () => {
    const segments: ContextLedgerSegment[] = [
      { bucket: "tools", text: '{"name":"Read"}' },
      { bucket: "conversation", text: "file contents here...." },
    ];
    const snap = assembleContextUsageSnapshot({
      segments,
      model: "m",
      contextWindow: 100_000,
      source: "live_assembly",
    });
    expect(snap.buckets.find((b) => b.id === "tools")!.tokens).toBeGreaterThan(0);
    expect(snap.buckets.find((b) => b.id === "conversation")!.tokens).toBeGreaterThan(0);
    expect(snap.estimatedInputTokens).toBe(
      snap.buckets.reduce((n, b) => n + b.tokens, 0),
    );
  });

  it("halves percentFull when contextWindow doubles", () => {
    const segments: ContextLedgerSegment[] = [
      { bucket: "conversation", text: "x".repeat(4000) },
    ];
    const a = assembleContextUsageSnapshot({
      segments, model: "m", contextWindow: 128_000, source: "live_assembly",
    });
    const b = assembleContextUsageSnapshot({
      segments, model: "m", contextWindow: 256_000, source: "live_assembly",
    });
    expect(a.buckets).toEqual(b.buckets);
    expect(b.percentFull!).toBeCloseTo(a.percentFull! / 2, 5);
  });

  it("emits overflow_after_model_switch tip", () => {
    const segments: ContextLedgerSegment[] = [
      { bucket: "conversation", text: "x".repeat(400_000) },
    ];
    const snap = assembleContextUsageSnapshot({
      segments,
      model: "small",
      contextWindow: 80_000,
      source: "live_assembly",
      modelSwitch: { previousContextWindow: 200_000 },
    });
    expect(snap.tips.some((t) => t.code === "overflow_after_model_switch")).toBe(true);
    expect(snap.percentFull!).toBeGreaterThan(1);
  });
});

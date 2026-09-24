import { describe, expect, it } from "vitest";

import { buildRuntimeMetricsSnapshot } from "../runtime-metrics.js";

describe("buildRuntimeMetricsSnapshot", () => {
  it("uses bounded operational labels and never includes prompts or tool arguments", () => {
    const snapshot = buildRuntimeMetricsSnapshot({
      runs: [{ id: "run-secret", sessionId: "s1", status: "completed", metadata: { prompt: "do not expose" }, createdAt: 1, updatedAt: 9, startedAt: 2, finishedAt: 8 }],
      attempts: [{ id: "a1", runId: "run-secret", sequence: 1, status: "completed", provider: "test", model: "m1", inputTokens: 3, outputTokens: 5, createdAt: 2, updatedAt: 8, startedAt: 2, finishedAt: 8 }],
      parts: [{ id: "p1", sessionId: "s1", messageId: "m1", seq: 1, type: "tool", status: "failed", toolName: "shell", input: { secret: "hide" }, metadata: { failureKind: "timeout" }, createdAt: 3, updatedAt: 7 }],
      tasks: [],
      permissions: [{ id: "perm", sessionId: "s1", toolName: "shell", payload: { secret: "hide" }, status: "pending", createdAt: 1, updatedAt: 1 }],
      settlements: [],
    } as any);

    expect(snapshot.gauges.vykor_permissions_pending).toBe(1);
    expect(snapshot.counters['vykor_tool_calls_total{failure_kind="timeout",status="failed",tool="shell"}']).toBe(1);
    expect(snapshot.histograms.vykor_run_duration_ms).toEqual({ count: 1, sum: 6, min: 6, max: 6 });
    expect(JSON.stringify(snapshot)).not.toContain("do not expose");
    expect(JSON.stringify(snapshot)).not.toContain("run-secret");
    expect(JSON.stringify(snapshot)).not.toContain("hide");
  });

  it("returns an empty snapshot instead of breaking runtime execution on malformed input", () => {
    expect(buildRuntimeMetricsSnapshot(null as any)).toEqual({ counters: {}, gauges: {}, histograms: {} });
  });
});

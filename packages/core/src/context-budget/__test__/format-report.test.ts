import { describe, expect, it } from "vitest";

import { formatContextUsageReport } from "../format-report.js";
import type { ContextUsageSnapshot } from "../types.js";

function baseSnapshot(overrides: Partial<ContextUsageSnapshot> = {}): ContextUsageSnapshot {
  return {
    model: "test-model",
    contextWindow: 100_000,
    estimatedInputTokens: 1_500,
    percentFull: 0.015,
    estimator: "heuristic_v1",
    buckets: [
      { id: "system", label: "系统提示", tokens: 1_000 },
      { id: "tools", label: "工具定义", tokens: 500 },
      { id: "rules", label: "规则", tokens: 0 },
      { id: "skills", label: "技能", tokens: 0 },
      { id: "mcp", label: "MCP 与动态工具", tokens: 0 },
      { id: "subagents", label: "子代理定义", tokens: 0 },
      { id: "summary", label: "对话摘要", tokens: 0 },
      { id: "conversation", label: "对话", tokens: 0 },
    ],
    tips: [{ code: "conversation_omitted", message: "本次快照未计入对话占用。" }],
    computedAt: "2026-09-05T00:00:00.000Z",
    source: "static_only",
    ...overrides,
  };
}

describe("formatContextUsageReport", () => {
  it("includes percent, totals, non-empty buckets, and tips", () => {
    const report = formatContextUsageReport(baseSnapshot());
    expect(report).toContain("1.5% 已用");
    expect(report).toContain("约 1,500 / 100,000 Tokens");
    expect(report).toContain("系统提示");
    expect(report).toContain("工具定义");
    expect(report).not.toContain("规则：");
    expect(report).toContain("conversation_omitted");
    expect(report).toContain("static_only");
  });

  it("shows placeholder when percentFull is null", () => {
    const report = formatContextUsageReport(
      baseSnapshot({ percentFull: null, contextWindow: null, estimatedInputTokens: 100 }),
    );
    expect(report).toContain("不适用");
    expect(report).toContain("约 100");
  });
});

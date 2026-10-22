import { estimateTokens } from "../utils/token-counter.js";
import { evaluateTips } from "./tips.js";
import type { AssembleContextUsageInput, ContextUsageBucket, ContextUsageSnapshot } from "./types.js";
import type { ContextBucketId } from "@vykor/agent-contracts";

const BUCKET_ORDER: readonly { id: ContextBucketId; label: string }[] = [
  { id: "system", label: "系统提示" },
  { id: "tools", label: "工具定义" },
  { id: "rules", label: "规则" },
  { id: "skills", label: "技能" },
  { id: "mcp", label: "MCP 与动态工具" },
  { id: "subagents", label: "子代理定义" },
  { id: "summary", label: "对话摘要" },
  { id: "conversation", label: "对话" },
];

function segmentTokens(text: string, mediaTokens?: number): number {
  return estimateTokens(text) + (mediaTokens ?? 0);
}

export function assembleContextUsageSnapshot(
  input: AssembleContextUsageInput,
): ContextUsageSnapshot {
  const tokenByBucket = new Map<ContextBucketId, number>(
    BUCKET_ORDER.map(({ id }) => [id, 0]),
  );

  for (const segment of input.segments) {
    const current = tokenByBucket.get(segment.bucket) ?? 0;
    tokenByBucket.set(
      segment.bucket,
      current + segmentTokens(segment.text, segment.mediaTokens),
    );
  }

  const buckets: ContextUsageBucket[] = BUCKET_ORDER.map(({ id, label }) => ({
    id,
    label,
    tokens: tokenByBucket.get(id) ?? 0,
  }));

  const estimatedInputTokens = buckets.reduce((sum, bucket) => sum + bucket.tokens, 0);
  const percentFull =
    input.contextWindow == null
      ? null
      : estimatedInputTokens / input.contextWindow;

  const autoTips = evaluateTips({
    estimatedInputTokens,
    contextWindow: input.contextWindow,
    toolsTokens: tokenByBucket.get("tools") ?? 0,
    mcpTokens: tokenByBucket.get("mcp") ?? 0,
    modelSwitch: input.modelSwitch,
  });

  const tips = [...autoTips, ...(input.extraTips ?? [])];

  return {
    model: input.model,
    contextWindow: input.contextWindow,
    outputLimit: input.outputLimit,
    estimatedInputTokens,
    percentFull,
    estimator: "heuristic_v1",
    buckets,
    tips,
    computedAt: new Date().toISOString(),
    source: input.source,
  };
}

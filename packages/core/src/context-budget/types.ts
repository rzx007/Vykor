import type { ContextBucketId, ContextLedgerSegment } from "@vykor/agent-contracts";
export type ContextUsageTipCode =
  | "near_full"
  | "overflow_after_model_switch"
  | "static_tools_heavy"
  | "conversation_omitted"
  | "partial_sources"
  | "media_unestimated"
  | "no_context_window"
  | "stale_or_rebuilt";

export interface ContextUsageBucket {
  id: ContextBucketId;
  label: string;
  tokens: number;
}

export interface ContextUsageTip {
  code: ContextUsageTipCode;
  message: string;
}

export type ContextUsageSource = "live_assembly" | "session_cache" | "static_only";

export interface ContextUsageSnapshot {
  model: string;
  contextWindow: number | null;
  /** 仅供展示/后续预留；v1 不计入 percentFull 分母 */
  outputLimit?: number | null;
  estimatedInputTokens: number;
  /**
   * estimatedInputTokens / contextWindow。
   * 分母为裸 contextWindow（不扣 outputReserve）。
   * 与 compact 内部阈值（另扣 summary/buffer）不对齐，属已知差异。
   * 无窗宽时为 null。允许大于 1。
   */
  percentFull: number | null;
  estimator: "heuristic_v1";
  buckets: ContextUsageBucket[];
  tips: ContextUsageTip[];
  computedAt: string;
  /** 快照是否来自与上一跳发送同源的缓存 */
  source: ContextUsageSource;
}

export interface ModelSwitchContext {
  previousContextWindow: number;
}

export interface AssembleContextUsageInput {
  segments: ContextLedgerSegment[];
  model: string;
  contextWindow: number | null;
  outputLimit?: number | null;
  source: ContextUsageSource;
  modelSwitch?: ModelSwitchContext;
  extraTips?: ContextUsageTip[];
}

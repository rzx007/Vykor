import type { ContentBlock } from "./messages";
import type { AssistantMessagePhase } from "./messages";
import type { UsageSnapshot } from "./usage";
import type {
  GenerationIdentity,
  ModelAttemptFinishedEvent,
  ModelRetryState,
} from "../engine/model-retry";

export interface TextDeltaEvent {
  type: "text_delta";
  delta: string;
  phase?: AssistantMessagePhase;
}

export type ReasoningSource = "reasoning_content" | "think";

export interface ReasoningDeltaEvent {
  type: "reasoning_delta";
  delta: string;
  source: ReasoningSource;
}

export interface ToolUseStartEvent {
  type: "tool_use_start";
  toolUse: {
    type: "tool_use";
    id: string;
    name: string;
    input: Record<string, unknown>;
  };
}

export interface ToolUseEndEvent {
  type: "tool_use_end";
  toolUseId: string;
  result: {
    content: ContentBlock[];
    isError?: boolean;
    failureKind?: import("./tools").ToolFailureKind;
    executionState?: import("./tools").ToolExecutionState;
    recoveryHint?: string;
    compactSummary?: string;
    toolAttemptId?: string;
    metadata?: Record<string, unknown>;
  };
}

export interface ErrorEvent {
  type: "error";
  error: Error;
}

export interface UsageEvent {
  type: "usage";
  usage: UsageSnapshot;
}

export interface CompleteEvent {
  type: "complete";
  stopReason: string;
}

/**
 * 每次实际请求前发出。重试开始时，它同时是「撤换上一次残缺输出」的明确边界：
 * 文本等事件在有序流内归属最近的 generation_started。
 */
export type GenerationStartedEvent = GenerationIdentity & {
  type: "generation_started";
};

/** 等待下一次重试前发出，携带次数、原因和截止时间。 */
export type ModelRetryEvent = ModelRetryState & { type: "model_retry" };

/** 每次实际请求恰好结算一次（含失败、取消和最后一次耗尽）。 */
export type { ModelAttemptFinishedEvent };

export type StreamEvent =
  | TextDeltaEvent
  | ReasoningDeltaEvent
  | ToolUseStartEvent
  | ToolUseEndEvent
  | ErrorEvent
  | UsageEvent
  | CompleteEvent
  | GenerationStartedEvent
  | ModelRetryEvent
  | ModelAttemptFinishedEvent;

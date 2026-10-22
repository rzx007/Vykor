import type { ContentBlock, ToolUseBlock } from "@vykor/agent-contracts";
import type { AssistantMessagePhase } from "@vykor/agent-contracts";
import type { UsageSnapshot } from "@vykor/agent-contracts";
import type {
  GenerationIdentity,
  ModelAttemptFinishedEvent,
  ModelRetryState,
} from "@vykor/agent-contracts";

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
  toolUse: ToolUseBlock;
}

/** Display-only: partial arguments never authorize or execute a tool. */
export interface ToolGenerationProgressEvent {
  type: "tool_generation_progress";
  toolKey: string;
  toolUseId?: string;
  toolName?: string;
  receivedChars: number;
  /** Omitted keeps the current display path; null explicitly withdraws it. */
  filePath?: string | null;
  discarded?: boolean;
  generationId?: string;
  attempt?: number;
}

export interface ToolUseEndEvent {
  type: "tool_use_end";
  toolUseId: string;
  pluginAppOrigin?: import("@vykor/protocol").PluginAppToolOrigin;
  result: {
    content: ContentBlock[];
    isError?: boolean;
    failureKind?: import("@vykor/agent-contracts").ToolFailureKind;
    executionState?: import("@vykor/agent-contracts").ToolExecutionState;
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

export type StreamEvent =
  | TextDeltaEvent
  | ReasoningDeltaEvent
  | ToolUseStartEvent
  | ToolGenerationProgressEvent
  | ToolUseEndEvent
  | ErrorEvent
  | UsageEvent
  | CompleteEvent
  | GenerationStartedEvent
  | ModelRetryEvent
  | ModelAttemptFinishedEvent;

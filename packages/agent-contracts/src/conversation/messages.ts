import type { ContentBlock } from "../tools/tool-data.js";
export type { ContentBlock, TextBlock, ImageBlock, ImageSource, VisionImagePreparationMetadata } from "../tools/tool-data.js";
export interface SystemMessage {
  type: "system";
  content: string;
}

export type CompactRole = "summary" | "boundary";

export interface UserMessage {
  type: "user";
  content: string | ContentBlock[];
  /** 压缩边界标记；不改变发给模型的 content。 */
  compactRole?: CompactRole;
}

export interface AssistantMessage {
  type: "assistant";
  content: string;
  phase?: AssistantMessagePhase;
  toolUses?: ToolUseBlock[];
  /** 展示与落盘用的思考内容，两类来源合并。 */
  reasoning?: string;
  /** 仅当上游用 reasoning_content 提供思考内容时存在，用于回传。 */
  reasoningReplay?: string;
  /** 来源及顺序，供压缩重写 transcript 时无损还原。 */
  reasoningSegments?: Array<{ source: "reasoning_content" | "think"; text: string }>;
  /** 压缩摘要消息；不改变发给模型的 content。 */
  compactRole?: CompactRole;
}

export type AssistantMessagePhase = "commentary" | "final_answer";

export interface ToolResultMessage {
  resultRef?: import("../tools/result-data.js").ToolResultRef;
  type: "tool_result";
  toolUseId: string;
  content: ContentBlock[];
  isError?: boolean;
  failureKind?: import("../tools/tool-data.js").ToolFailureKind;
  executionState?: import("../tools/tool-data.js").ToolExecutionState;
  recoveryHint?: string;
  compactSummary?: string;
}

export type Message =
  | SystemMessage
  | UserMessage
  | AssistantMessage
  | ToolResultMessage;

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
  /** Unparsed input uses an empty placeholder and must never reach tool execution. */
  inputError?: {
    reason: "invalid_json" | "invalid_shape";
    /** Character count, not a copy of potentially sensitive file content. */
    argumentLength: number;
    position?: number;
    stopReason?: string;
  };
}

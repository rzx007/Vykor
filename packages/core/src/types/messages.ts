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
  type: "tool_result";
  toolUseId: string;
  content: ContentBlock[];
  isError?: boolean;
  failureKind?: import("./tools").ToolFailureKind;
  executionState?: import("./tools").ToolExecutionState;
  recoveryHint?: string;
  compactSummary?: string;
}

export type Message =
  | SystemMessage
  | UserMessage
  | AssistantMessage
  | ToolResultMessage;

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ImageBlock {
  type: "image";
  source: ImageSource;
}

export interface ImageSource {
  type: "file";
  mediaType: string;
  path: string;
  sizeBytes?: number;
  prepared?: VisionImagePreparationMetadata;
}

export interface VisionImagePreparationMetadata {
  mediaType: string;
  width: number;
  height: number;
  base64Bytes: number;
  policyVersion: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export type ContentBlock = TextBlock | ImageBlock;

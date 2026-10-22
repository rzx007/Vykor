export type ContextBucketId =
  | "system"
  | "tools"
  | "rules"
  | "skills"
  | "mcp"
  | "subagents"
  | "summary"
  | "conversation";

export interface ContextLedgerSegment {
  bucket: ContextBucketId;
  /** 用于估算的文本；工具 schema 用稳定序列化字符串 */
  text: string;
  /** 可选：图片等非文本块的固定 token 估值，计入同一 bucket */
  mediaTokens?: number;
  /** 可选调试标签，v1 不上报 UI */
  source?: string;
}

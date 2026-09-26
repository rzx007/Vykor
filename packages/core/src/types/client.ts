import type { ContentBlock, Message } from "./messages";
import type { StreamEvent } from "./events";
import type { ToolDefinition } from "./tools";

export interface StreamMessageParams {
  model: string;
  messages: Message[];
  system?: string;
  tools?: ToolDefinition[];
  maxTokens?: number;
  temperature?: number;
  reasoningEffort?: string;
  abortSignal?: AbortSignal;
  /** 连接阶段（请求建立）的时间上限，毫秒。 */
  requestTimeoutMs?: number;
  /** 流连续没有收到协议事件/心跳的时间上限，毫秒。 */
  streamIdleTimeoutMs?: number;
}

export interface StreamingMessageClient {
  prepareUserContent?(
    content: string | ContentBlock[],
    options?: { signal?: AbortSignal },
  ): Promise<string | ContentBlock[]>;
  streamMessage(params: StreamMessageParams): AsyncIterable<StreamEvent>;
}

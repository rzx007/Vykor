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
}

export interface StreamingMessageClient {
  prepareUserContent?(
    content: string | ContentBlock[],
    options?: { signal?: AbortSignal },
  ): Promise<string | ContentBlock[]>;
  streamMessage(params: StreamMessageParams): AsyncIterable<StreamEvent>;
}

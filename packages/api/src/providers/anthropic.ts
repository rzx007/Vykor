import Anthropic from "@anthropic-ai/sdk";
import type {
  StreamingMessageClient,
  StreamMessageParams,
  StreamEvent,
  Message,
  ToolDefinition,
  ContentBlock,
} from "@vykor/core";
import { DEFAULT_OUTPUT_TOKEN_MAX } from "@vykor/core";
import {
  assertNativeImageMediaType,
  type NativeImageMediaType,
  type ProviderConfig,
} from "./registry";
import { AuthenticationFailure, RateLimitFailure, requestFailure } from "../errors/index";
import { abortableDelay } from "./retry";
import {
  prepareNativeImagePayload,
  prepareUserContentWithVisionImages,
} from "./native-image-payload.js";

const MAX_RETRIES = 3;
const BASE_DELAY = 1000;
const MAX_DELAY = 30_000;
const RETRYABLE_CODES = new Set([429, 500, 502, 503, 529]);

export class AnthropicClient implements StreamingMessageClient {
  private client: Anthropic;

  constructor(private config: ProviderConfig) {
    this.client = new Anthropic({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
    });
  }

  prepareUserContent(
    content: string | ContentBlock[],
    options?: { signal?: AbortSignal },
  ): Promise<string | ContentBlock[]> {
    return prepareUserContentWithVisionImages(content, options);
  }

  async *streamMessage(params: StreamMessageParams): AsyncIterable<StreamEvent> {
    params.abortSignal?.throwIfAborted();
    const messages = await this.convertMessages(
      params.messages,
      params.abortSignal,
    );
    const tools = params.tools?.map((t) => this.convertTool(t));

    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      params.abortSignal?.throwIfAborted();
      try {
        const stream = this.client.messages.stream({
          model: params.model,
          messages,
          system: params.system,
          tools: tools?.length ? tools : undefined,
          max_tokens: params.maxTokens ?? DEFAULT_OUTPUT_TOKEN_MAX,
          temperature: params.temperature,
        }, {
          signal: params.abortSignal,
        });

        const toolInputBuffers: Map<number, { id: string; name: string; partialJson: string }> =
          new Map();

        for await (const event of stream) {
          if (
            event.type === "content_block_delta" &&
            event.delta.type === "text_delta"
          ) {
            yield { type: "text_delta", delta: event.delta.text };
          } else if (
            event.type === "content_block_start" &&
            event.content_block.type === "tool_use"
          ) {
            toolInputBuffers.set(event.index, {
              id: event.content_block.id,
              name: event.content_block.name,
              partialJson: "",
            });
          } else if (
            event.type === "content_block_delta" &&
            event.delta.type === "input_json_delta"
          ) {
            const buf = toolInputBuffers.get(event.index);
            if (buf) {
              buf.partialJson += event.delta.partial_json;
            }
          } else if (event.type === "content_block_stop") {
            const buf = toolInputBuffers.get(event.index);
            if (buf) {
              let input: Record<string, unknown>;
              try {
                input = JSON.parse(buf.partialJson || "{}");
              } catch {
                input = {};
              }
              yield {
                type: "tool_use_start",
                toolUse: {
                  type: "tool_use",
                  id: buf.id,
                  name: buf.name,
                  input,
                },
              };
              toolInputBuffers.delete(event.index);
            }
          }
        }

        const final = await stream.finalMessage();
        yield {
          type: "usage",
          usage: {
            inputTokens: final.usage.input_tokens,
            outputTokens: final.usage.output_tokens,
            cacheCreationTokens: final.usage.cache_creation_input_tokens ?? undefined,
            cacheReadTokens: final.usage.cache_read_input_tokens ?? undefined,
          },
        };
        yield { type: "complete", stopReason: final.stop_reason ?? "end_turn" };
        return;
      } catch (error) {
        lastError = this.classifyError(error);
        const status = (error as any)?.status ?? (error as any)?.statusCode;
        params.abortSignal?.throwIfAborted();
        if (attempt < MAX_RETRIES && status && RETRYABLE_CODES.has(status)) {
          const retryAfter = this.getRetryAfter(error);
          const jitter = Math.random() * 1000;
          const delay = retryAfter > 0
            ? Math.min(retryAfter * 1000, MAX_DELAY)
            : Math.min(BASE_DELAY * 2 ** attempt + jitter, MAX_DELAY);
          await abortableDelay(delay, params.abortSignal);
          continue;
        }
        throw lastError;
      }
    }
    throw lastError;
  }

  private getRetryAfter(error: any): number {
    const header = error?.headers?.get?.("retry-after") ?? error?.headers?.["retry-after"];
    if (header) {
      const secs = Number(header);
      if (!isNaN(secs)) return secs;
    }
    return 0;
  }

  private classifyError(error: any): Error {
    const status = error?.status ?? error?.statusCode;
    const message = error?.message ?? String(error);

    if (status === 401 || status === 403) {
      return new AuthenticationFailure(message);
    }
    if (status === 429) {
      return new RateLimitFailure(message);
    }
    if (status) {
      return requestFailure(message, status);
    }
    return error instanceof Error ? error : new Error(message);
  }

  private async convertMessages(
    messages: Message[],
    signal?: AbortSignal,
  ): Promise<Anthropic.MessageParam[]> {
    const converted: Anthropic.MessageParam[] = [];
    for (const msg of messages) {
      signal?.throwIfAborted();
      switch (msg.type) {
        case "user":
          converted.push({
            role: "user" as const,
            content: await convertUserContentToAnthropic(msg.content, signal),
          });
          break;
        case "assistant": {
          const content: Anthropic.ContentBlockParam[] = [];
          if (msg.content) {
            content.push({ type: "text" as const, text: msg.content });
          }
          if (msg.toolUses?.length) {
            for (const tu of msg.toolUses) {
              content.push({
                type: "tool_use" as const,
                id: tu.id,
                name: tu.name,
                input: tu.input as Record<string, unknown>,
              });
            }
          }
          converted.push({
            role: "assistant" as const,
            content,
          });
          break;
        }
        case "tool_result":
          converted.push({
            role: "user" as const,
            content: [
              {
                type: "tool_result" as const,
                tool_use_id: msg.toolUseId,
                content: await convertUserContentToAnthropic(msg.content, signal),
                is_error: msg.isError,
              } as Anthropic.ToolResultBlockParam,
            ],
          });
          break;
        default:
          converted.push({
            role: "user" as const,
            content: JSON.stringify(msg),
          });
      }
    }
    return converted;
  }

  private convertTool(tool: ToolDefinition): Anthropic.Tool {
    return {
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
    };
  }
}

export async function convertUserContentToAnthropic(
  content: string | ContentBlock[],
  signal?: AbortSignal,
): Promise<string | Anthropic.ContentBlockParam[]> {
  if (typeof content === "string") return content;
  const converted: Anthropic.ContentBlockParam[] = [];
  for (const block of content) {
    signal?.throwIfAborted();
    if (block.type === "text") {
      if (block.text) converted.push({ type: "text", text: block.text });
      continue;
    }
    const prepared = await prepareNativeImagePayload(block, signal);
    assertNativeImageMediaType(prepared.mediaType);
    converted.push({
      type: "image",
      source: {
        type: "base64",
        media_type: prepared.mediaType as NativeImageMediaType,
        data: prepared.base64,
      },
    });
  }
  return converted;
}

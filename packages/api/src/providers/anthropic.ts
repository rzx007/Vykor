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
import {
  protocolFailure,
  streamIncompleteFailure,
  toModelRequestFailure,
} from "../errors/index";
import { createRequestLifecycle } from "./retry";
import {
  prepareNativeImagePayload,
  prepareUserContentWithVisionImages,
} from "./native-image-payload.js";

export class AnthropicClient implements StreamingMessageClient {
  private client: Anthropic;

  constructor(private config: ProviderConfig) {
    this.client = new Anthropic({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      maxRetries: 0,
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

    const lifecycle = createRequestLifecycle({
      external: params.abortSignal,
      requestTimeoutMs: params.requestTimeoutMs,
      streamIdleTimeoutMs: params.streamIdleTimeoutMs,
    });

    try {
      let stream: ReturnType<Anthropic["messages"]["stream"]>;
      try {
        stream = this.client.messages.stream({
          model: params.model,
          messages,
          system: params.system,
          tools: tools?.length ? tools : undefined,
          max_tokens: params.maxTokens ?? DEFAULT_OUTPUT_TOKEN_MAX,
          temperature: params.temperature,
        }, {
          signal: lifecycle.signal,
        });
      } catch (error) {
        throw this.failModelRequest(error, "request", lifecycle, params.abortSignal);
      }

      const toolInputBuffers: Map<number, { id: string; name: string; partialJson: string }> =
        new Map();
      const completedToolUses: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];
      let sawMessageStop = false;
      let usage: { inputTokens: number; outputTokens: number; cacheCreationTokens?: number; cacheReadTokens?: number } | undefined;

      lifecycle.markStreamStarted();
      try {
        for await (const event of stream) {
          lifecycle.touch();
          if (event.type === "message_stop") {
            sawMessageStop = true;
          } else if (event.type === "message_start") {
            const current = event.message.usage;
            usage = {
              inputTokens: current.input_tokens,
              outputTokens: current.output_tokens,
              cacheCreationTokens: current.cache_creation_input_tokens ?? undefined,
              cacheReadTokens: current.cache_read_input_tokens ?? undefined,
            };
            yield { type: "usage", usage };
          } else if (event.type === "message_delta" && usage) {
            usage = { ...usage, outputTokens: event.usage.output_tokens };
            yield { type: "usage", usage };
          } else if (
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
              completedToolUses.push({
                id: buf.id,
                name: buf.name,
                input: parseToolInput(buf),
              });
              toolInputBuffers.delete(event.index);
            }
          }
        }
      } catch (error) {
        throw this.failModelRequest(error, "stream", lifecycle, params.abortSignal);
      }

      if (!sawMessageStop) {
        throw streamIncompleteFailure("Anthropic 流在收到 message_stop 前结束");
      }

      let final: Awaited<ReturnType<typeof stream.finalMessage>>;
      try {
        final = await stream.finalMessage();
      } catch (error) {
        throw this.failModelRequest(error, "stream", lifecycle, params.abortSignal);
      }

      for (const toolUse of completedToolUses) {
        yield {
          type: "tool_use_start",
          toolUse: { type: "tool_use", id: toolUse.id, name: toolUse.name, input: toolUse.input },
        };
      }

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
    } finally {
      lifecycle.dispose();
    }
  }

  private failModelRequest(
    error: unknown,
    phase: "request" | "stream",
    lifecycle: ReturnType<typeof createRequestLifecycle>,
    external?: AbortSignal,
  ): Error {
    if (external?.aborted) {
      return external.reason instanceof Error ? external.reason : new Error(String(external.reason));
    }
    const timeout = lifecycle.timeoutFailure();
    if (timeout) return timeout;
    return toModelRequestFailure(error, phase);
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

function parseToolInput(buf: { name: string; partialJson: string }): Record<string, unknown> {
  if (!buf.partialJson) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(buf.partialJson);
  } catch {
    throw protocolFailure(`Anthropic 工具调用参数不是合法 JSON（tool=${buf.name}）`);
  }
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
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

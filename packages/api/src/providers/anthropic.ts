import Anthropic from "@anthropic-ai/sdk";
import type {
  StreamingMessageClient,
  StreamMessageParams,
  StreamEvent,
  Message,
  ToolDefinition,
  ContentBlock,
  ToolUseBlock,
} from "@vykor/core";
import { DEFAULT_OUTPUT_TOKEN_MAX, ModelRequestFailure } from "@vykor/core";
import {
  assertNativeImageMediaType,
  type NativeImageMediaType,
  type ProviderConfig,
} from "./registry";
import {
  streamIncompleteFailure,
  toModelRequestFailure,
} from "../errors/index";
import { createRequestLifecycle } from "./retry";
import { parseToolInput } from "./tool-input.js";
import {
  prepareNativeImagePayload,
  prepareUserContentWithVisionImages,
  replaceMissingToolResultImages,
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
      // The high-level MessageStream parses partial tool JSON before emitting it.
      // Read raw events so malformed arguments can reach our recovery boundary.
      let stream: AsyncIterable<Anthropic.MessageStreamEvent>;
      let responseHeaders: unknown;
      try {
        const result = await this.client.messages.create({
          model: params.model,
          messages,
          system: params.system,
          tools: tools?.length ? tools : undefined,
          max_tokens: params.maxTokens ?? DEFAULT_OUTPUT_TOKEN_MAX,
          temperature: params.temperature,
          stream: true,
        }, {
          signal: lifecycle.signal,
        }).withResponse();
        stream = result.data;
        responseHeaders = result.response.headers;
      } catch (error) {
        throw this.failModelRequest(error, "request", lifecycle, params.abortSignal);
      }

      const toolInputBuffers: Map<number, { id: string; name: string; initialInput: unknown; partialJson: string }> =
        new Map();
      const completedToolUses: ToolUseBlock[] = [];
      let sawMessageStop = false;
      let stopReason: string = "end_turn";
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
          } else if (event.type === "message_delta") {
            if (event.delta.stop_reason) stopReason = event.delta.stop_reason;
            if (usage) {
              usage = { ...usage, outputTokens: event.usage.output_tokens };
              yield { type: "usage", usage };
            }
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
              initialInput: event.content_block.input,
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
                type: "tool_use",
                id: buf.id,
                name: buf.name,
                ...parseToolInput(buf.partialJson || JSON.stringify(buf.initialInput)),
              });
              toolInputBuffers.delete(event.index);
            }
          }
        }
      } catch (error) {
        throw this.failModelRequest(error, "stream", lifecycle, params.abortSignal, responseHeaders);
      }

      if (!sawMessageStop) {
        throw streamIncompleteFailure("Anthropic 流在收到 message_stop 前结束");
      }

      for (const toolUse of completedToolUses) {
        if (toolUse.inputError) toolUse.inputError.stopReason = stopReason;
        yield {
          type: "tool_use_start",
          toolUse,
        };
      }

      yield { type: "complete", stopReason };
    } finally {
      lifecycle.dispose();
    }
  }

  private failModelRequest(
    error: unknown,
    phase: "request" | "stream",
    lifecycle: ReturnType<typeof createRequestLifecycle>,
    external?: AbortSignal,
    responseHeaders?: unknown,
  ): Error {
    if (external?.aborted) {
      return external.reason instanceof Error ? external.reason : new Error(String(external.reason));
    }
    const timeout = lifecycle.timeoutFailure();
    if (timeout) return timeout;
    if (error instanceof ModelRequestFailure) return error;
    // SDK 0.40 wraps SSE errors as APIConnectionError with the JSON frame in
    // its message. Decode only that SDK shape, preserving the original cause.
    if (phase === "stream" && error instanceof Anthropic.APIConnectionError) {
      let payload: unknown;
      try { payload = JSON.parse(error.message); } catch { /* Ordinary connection errors stay unchanged. */ }
      if (payload && typeof payload === "object" && "type" in payload && payload.type === "error"
        && "error" in payload && payload.error && typeof payload.error === "object") {
        return toModelRequestFailure({
          error: payload.error,
          message: "message" in payload.error ? payload.error.message : error.message,
          headers: responseHeaders ?? error.headers,
          request_id: "request_id" in payload ? payload.request_id : error.request_id,
          cause: error,
        }, phase);
      }
    }
    return toModelRequestFailure(responseHeaders ? {
      message: error instanceof Error ? error.message : String(error),
      headers: responseHeaders,
      cause: error,
    } : error, phase);
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
                content: await convertUserContentToAnthropic(
                  await replaceMissingToolResultImages(msg.content),
                  signal,
                ),
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

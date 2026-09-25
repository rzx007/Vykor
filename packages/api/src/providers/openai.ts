import OpenAI from "openai";
import type {
  StreamingMessageClient,
  StreamMessageParams,
  StreamEvent,
  ToolDefinition,
  ContentBlock,
} from "@vykor/core";
import { DEFAULT_OUTPUT_TOKEN_MAX } from "@vykor/core";
import { assertNativeImageMediaType, type ProviderConfig } from "./registry";
import { AuthenticationFailure, RateLimitFailure, requestFailure } from "../errors/index";
import { abortableDelay } from "./retry";
import {
  createDsmlRecoveryScanner,
  type DsmlRecoveryScanner,
  type RecoveredToolCall,
} from "./dsml-tool-call-recovery.js";
import {
  prepareNativeImagePayload,
  preparedImageDataUrl,
  prepareUserContentWithVisionImages,
} from "./native-image-payload.js";
import { extractThinkBlocks } from "./think-blocks.js";

const MAX_RETRIES = 3;
const BASE_DELAY = 1000;
const MAX_DELAY = 30_000;
const RETRYABLE_CODES = new Set([429, 500, 502, 503]);

// Model families that reject `max_tokens` and require `max_completion_tokens`.
const MAX_COMPLETION_TOKEN_MODEL_PREFIXES = ["gpt-5", "o1", "o3", "o4"];

// Env var opt-in for emitting an empty `reasoning_content` on tool-use
// assistant turns (Kimi-on-Anthropic style). Strict-OpenAI providers reject
// the field outright, so the default is off.
const EMPTY_REASONING_ENV = "VYKOR_REQUIRE_EMPTY_REASONING_CONTENT";

// DSML tool-call recovery is on by default because DeepSeek V4 intermittently
// leaks tool calls into the content channel at long context. Set this to a
// truthy value to fall back to forwarding the raw markup as text.
const DSML_RECOVERY_DISABLE_ENV = "VYKOR_DISABLE_DSML_RECOVERY";

interface ReasoningMessage {
  content?: string | null;
  role: string;
  reasoning_content?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
}

/**
 * Return the correct token-limit field for the target OpenAI model.
 *
 * GPT-5 and the current reasoning-model families (o1/o3/o4) reject
 * `max_tokens` and require `max_completion_tokens` instead.
 */
export function tokenLimitParamForModel(
  model: string,
  maxTokens: number,
): { max_tokens: number } | { max_completion_tokens: number } {
  let normalized = model.trim().toLowerCase();
  if (normalized.includes("/")) {
    normalized = normalized.slice(normalized.lastIndexOf("/") + 1);
  }
  if (MAX_COMPLETION_TOKEN_MODEL_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return { max_completion_tokens: maxTokens };
  }
  return { max_tokens: maxTokens };
}

function emptyReasoningRequired(): boolean {
  return envFlagEnabled(EMPTY_REASONING_ENV);
}

function envFlagEnabled(name: string): boolean {
  const raw = (process.env[name] ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function nonEmptyText(content: string): string {
  return content.trim() ? content : " ";
}

/**
 * Convert user text/image content blocks into OpenAI chat content. Returns a
 * plain string when there are no images, otherwise the structured multimodal
 * array with `image_url` data-URI blocks.
 */
export function convertUserContentToOpenAI(
  blocks: ContentBlock[],
  signal?: AbortSignal,
): Promise<string | OpenAI.ChatCompletionContentPart[]> {
  const hasImage = blocks.some((b) => b.type === "image");
  if (!hasImage) {
    return Promise.resolve(blocks
      .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join(""));
  }

  return convertMultimodalContentToOpenAI(blocks, signal);
}

async function convertMultimodalContentToOpenAI(
  blocks: ContentBlock[],
  signal?: AbortSignal,
): Promise<OpenAI.ChatCompletionContentPart[]> {
  const content: OpenAI.ChatCompletionContentPart[] = [];
  for (const block of blocks) {
    if (block.type === "text" && block.text) {
      content.push({ type: "text", text: block.text });
    } else if (block.type === "image") {
      content.push({
        type: "image_url",
        image_url: { url: await imageBlockToDataUrl(block, signal) },
      });
    }
  }
  return content;
}

async function imageBlockToDataUrl(
  block: Extract<ContentBlock, { type: "image" }>,
  signal?: AbortSignal,
): Promise<string> {
  const prepared = await prepareNativeImagePayload(block, signal);
  assertNativeImageMediaType(prepared.mediaType);
  return preparedImageDataUrl(prepared);
}

export class OpenAICompatibleClient implements StreamingMessageClient {
  private _client: OpenAI;

  constructor(private config: ProviderConfig) {
    this._client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      defaultHeaders: config.headers,
    });
  }

  get client(): OpenAI {
    return this._client;
  }

  set client(value: OpenAI) {
    this._client = value;
  }

  prepareUserContent(
    content: string | ContentBlock[],
    options?: { signal?: AbortSignal },
  ): Promise<string | ContentBlock[]> {
    return prepareUserContentWithVisionImages(content, options);
  }

  async *streamMessage(params: StreamMessageParams): AsyncIterable<StreamEvent> {
    const messages = await this.convertMessages(params);
    const tools = params.tools?.length ? params.tools.map(this.convertTool) : undefined;

    const createParams: OpenAI.ChatCompletionCreateParamsStreaming = {
      model: params.model,
      messages: messages as OpenAI.ChatCompletionMessageParam[],
      ...tokenLimitParamForModel(params.model, params.maxTokens ?? DEFAULT_OUTPUT_TOKEN_MAX),
      temperature: params.temperature,
      stream: true,
      stream_options: tools ? undefined : { include_usage: true },
      ...(params.reasoningEffort
        ? {
            reasoning_effort:
              params.reasoningEffort as OpenAI.ChatCompletionCreateParamsStreaming["reasoning_effort"],
          }
        : {}),
      tools,
    };

    const collectedToolCalls: Map<number, { id: string; name: string; arguments: string }> =
      new Map();
    let finishReason: string | null = null;
    let usageData = { inputTokens: 0, outputTokens: 0 };
    // Buffer to strip inline <think>…</think> blocks across streaming chunks.
    let thinkBuf = "";
    let recoveredToolCalls: RecoveredToolCall[] = [];
    let recovery: DsmlRecoveryScanner | undefined;
    let emittedAnyText = false;

    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      params.abortSignal?.throwIfAborted();
      // Reset per-attempt accumulated state so a retry starts from a clean slate.
      collectedToolCalls.clear();
      finishReason = null;
      thinkBuf = "";
      recoveredToolCalls = [];
      emittedAnyText = false;
      const declaredTools = params.tools;
      recovery =
        declaredTools?.length && !envFlagEnabled(DSML_RECOVERY_DISABLE_ENV)
          ? createDsmlRecoveryScanner({
              declaredToolNames: new Set(declaredTools.map((tool) => tool.name)),
            })
          : undefined;
      try {
        const stream = await this._client.chat.completions.create(createParams, {
          signal: params.abortSignal,
        });

        for await (const chunk of stream) {
          if (!chunk.choices || chunk.choices.length === 0) {
            if (chunk.usage) {
              usageData = {
                inputTokens: chunk.usage.prompt_tokens ?? 0,
                outputTokens: chunk.usage.completion_tokens ?? 0,
              };
            }
            continue;
          }

          const choice = chunk.choices[0]!;
          const delta = choice.delta;
          if (choice.finish_reason) finishReason = choice.finish_reason;

          if (delta.content) {
            thinkBuf += delta.content;
            const extracted = extractThinkBlocks(thinkBuf);
            thinkBuf = extracted.leftover;
            if (extracted.reasoning) {
              yield {
                type: "reasoning_delta",
                delta: extracted.reasoning,
                source: "think",
              };
            }
            if (extracted.visible) {
              const scanned = recovery
                ? recovery.push(extracted.visible)
                : { visible: extracted.visible, toolCalls: [] as RecoveredToolCall[] };
              if (scanned.visible) {
                emittedAnyText = true;
                yield { type: "text_delta", delta: scanned.visible };
              }
              recoveredToolCalls.push(...scanned.toolCalls);
            }
          }

          const reasoningPiece = (delta as any).reasoning_content;
          if (reasoningPiece) {
            yield {
              type: "reasoning_delta",
              delta: reasoningPiece,
              source: "reasoning_content",
            };
          }

          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index;
              if (!collectedToolCalls.has(idx)) {
                collectedToolCalls.set(idx, { id: tc.id ?? "", name: "", arguments: "" });
              }
              const entry = collectedToolCalls.get(idx)!;
              if (tc.id) entry.id = tc.id;
              if (tc.function?.name) entry.name = tc.function.name;
              if (tc.function?.arguments) entry.arguments += tc.function.arguments;
            }
          }

          if (chunk.usage) {
            usageData = {
              inputTokens: chunk.usage.prompt_tokens ?? 0,
              outputTokens: chunk.usage.completion_tokens ?? 0,
            };
          }
        }

        // Flush any remaining buffered content (e.g. a partial <think> prefix at EOF).
        if (thinkBuf) {
          const extracted = extractThinkBlocks(thinkBuf, { final: true });
          if (extracted.reasoning) {
            yield { type: "reasoning_delta", delta: extracted.reasoning, source: "think" };
          }
          if (extracted.visible) {
            const scanned = recovery
              ? recovery.push(extracted.visible)
              : { visible: extracted.visible, toolCalls: [] as RecoveredToolCall[] };
            if (scanned.visible) {
              emittedAnyText = true;
              yield { type: "text_delta", delta: scanned.visible };
            }
            recoveredToolCalls.push(...scanned.toolCalls);
          }
          thinkBuf = "";
        }
        if (recovery) {
          const tail = recovery.flush();
          if (tail.visible) {
            emittedAnyText = true;
            yield { type: "text_delta", delta: tail.visible };
          }
          recoveredToolCalls.push(...tail.toolCalls);
        }
        break;
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

    let nativeToolUseCount = 0;
    for (const [, tc] of collectedToolCalls) {
      if (!tc.name) continue;
      nativeToolUseCount++;
      let input: Record<string, unknown>;
      try {
        input = JSON.parse(tc.arguments || "{}");
      } catch {
        input = {};
      }
      yield {
        type: "tool_use_start",
        toolUse: { type: "tool_use", id: tc.id, name: tc.name, input },
      };
    }

    for (const call of recoveredToolCalls) {
      yield {
        type: "tool_use_start",
        toolUse: { type: "tool_use", id: call.id, name: call.name, input: call.input },
      };
    }

    yield {
      type: "usage",
      usage: {
        inputTokens: usageData.inputTokens,
        outputTokens: usageData.outputTokens,
      },
    };

    const toolUseCount = nativeToolUseCount + recoveredToolCalls.length;
    if (finishReason === "tool_calls" && toolUseCount === 0 && !emittedAnyText) {
      yield {
        type: "text_delta",
        delta:
          "⚠️ 上游声明了工具调用（finish_reason=tool_calls），但没有返回可执行的调用内容，本轮未执行任何工具。",
      };
    }

    const normalizedStopReason =
      finishReason === "length" ? "max_tokens" : finishReason ?? "end_turn";
    yield {
      type: "complete",
      stopReason: toolUseCount > 0 ? "tool_use" : normalizedStopReason,
    };
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

  private async convertMessages(params: StreamMessageParams): Promise<OpenAI.ChatCompletionMessageParam[]> {
    const messages: OpenAI.ChatCompletionMessageParam[] = [];
    let pendingToolImages: Array<Extract<ContentBlock, { type: "image" }>> = [];

    const flushToolImages = async () => {
      if (!pendingToolImages.length) return;
      const content = await convertUserContentToOpenAI(pendingToolImages, params.abortSignal);
      if (Array.isArray(content) && content.length) messages.push({ role: "user", content });
      pendingToolImages = [];
    };

    if (params.system) {
      messages.push({ role: "system", content: params.system });
    }

    for (const msg of params.messages) {
      if (msg.type !== "tool_result") await flushToolImages();
      switch (msg.type) {
        case "user": {
          if (typeof msg.content === "string") {
            messages.push({ role: "user", content: nonEmptyText(msg.content) });
          } else {
            const content = await convertUserContentToOpenAI(
              msg.content,
              params.abortSignal,
            );
            if (typeof content === "string") {
              messages.push({ role: "user", content: nonEmptyText(content) });
            } else if (content.length) {
              messages.push({ role: "user", content });
            }
          }
          break;
        }
        case "assistant": {
          const rawContent = typeof msg.content === "string" ? msg.content : "";
          const assistantMsg: ReasoningMessage = {
            role: "assistant",
            content: nonEmptyText(rawContent),
          };
          if (msg.reasoningReplay) {
            assistantMsg.reasoning_content = msg.reasoningReplay;
          } else if (msg.toolUses?.length && emptyReasoningRequired()) {
            assistantMsg.reasoning_content = "";
          }
          if (msg.toolUses?.length) {
            assistantMsg.tool_calls = msg.toolUses.map((tc) => ({
              id: tc.id,
              type: "function" as const,
              function: {
                name: tc.name,
                arguments: typeof tc.input === "string" ? tc.input : JSON.stringify(tc.input),
              },
            }));
          }
          messages.push(assistantMsg as unknown as OpenAI.ChatCompletionMessageParam);
          break;
        }
        case "tool_result": {
          const text = msg.content
            .filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
            .map((block) => block.text)
            .join("\n");
          pendingToolImages.push(...msg.content.filter(
            (block): block is Extract<ContentBlock, { type: "image" }> => block.type === "image",
          ));
          messages.push({
            role: "tool",
            tool_call_id: msg.toolUseId,
            content: nonEmptyText(text),
          });
          break;
        }
      }
    }

    await flushToolImages();

    return messages;
  }

  private convertTool(tool: ToolDefinition): OpenAI.ChatCompletionTool {
    return {
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema as OpenAI.FunctionParameters,
      },
    };
  }
}

import { platform, machine } from "node:os";
import type {
  ContentBlock,
  Message,
  StreamEvent,
  StreamingMessageClient,
  StreamMessageParams,
  ToolDefinition,
} from "@vykor/core";
import { assertNativeImageMediaType, type ProviderConfig } from "./registry";
import { AuthenticationFailure, RateLimitFailure, RequestFailure, requestFailure } from "../errors/index";
import {
  prepareNativeImagePayload,
  preparedImageDataUrl,
  prepareUserContentWithVisionImages,
} from "./native-image-payload.js";

const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const JWT_AUTH_CLAIM = "https://api.openai.com/auth";
const MAX_RETRIES = 3;
const BASE_DELAY = 1000;
const MAX_DELAY = 30_000;
const RETRYABLE_CODES = new Set([429, 500, 502, 503, 504]);

export function resolveCodexUrl(baseURL?: string): string {
  let trimmed = (baseURL ?? "").trim();
  if (trimmed && !trimmed.includes("chatgpt.com/backend-api")) {
    trimmed = "";
  }
  const raw = (trimmed || DEFAULT_CODEX_BASE_URL).replace(/\/+$/, "");
  if (raw.endsWith("/codex/responses")) return raw;
  if (raw.endsWith("/codex")) return `${raw}/responses`;
  return `${raw}/codex/responses`;
}

export function buildCodexHeaders(token: string, sessionId?: string): Record<string, string> {
  const accountId = extractAccountId(token);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "chatgpt-account-id": accountId,
    originator: "vykor",
    "User-Agent": `vykor (${platform().toLowerCase()} ${machine() || "unknown"})`,
    "OpenAI-Beta": "responses=experimental",
    accept: "text/event-stream",
    "content-type": "application/json",
  };
  if (sessionId) headers.session_id = sessionId;
  return headers;
}

export class CodexSubscriptionClient implements StreamingMessageClient {
  private readonly url: string;

  constructor(private config: ProviderConfig) {
    this.url = resolveCodexUrl(config.baseURL);
  }

  prepareUserContent(
    content: string | ContentBlock[],
    options?: { signal?: AbortSignal },
  ): Promise<string | ContentBlock[]> {
    return prepareUserContentWithVisionImages(content, options);
  }

  async *streamMessage(params: StreamMessageParams): AsyncIterable<StreamEvent> {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        yield* this.streamOnce(params);
        return;
      } catch (error) {
        lastError = this.classifyError(error);
        const status = (error as any)?.status ?? (error as any)?.statusCode;
        if (attempt < MAX_RETRIES && status && RETRYABLE_CODES.has(status)) {
          const jitter = Math.random() * 1000;
          const delay = Math.min(BASE_DELAY * 2 ** attempt + jitter, MAX_DELAY);
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
        throw lastError;
      }
    }
    if (lastError) throw lastError;
  }

  private async *streamOnce(params: StreamMessageParams): AsyncIterable<StreamEvent> {
    const input = await convertMessagesToCodex(params.messages, params.abortSignal);
    const body: Record<string, unknown> = {
      model: params.model,
      store: false,
      stream: true,
      instructions: params.system || "You are Vykor.",
      input,
      text: { verbosity: "medium" },
      include: ["reasoning.encrypted_content"],
      tool_choice: "auto",
      parallel_tool_calls: true,
    };
    if (params.tools?.length) {
      body.tools = params.tools.map(convertToolToCodex);
    }

    const response = await fetch(this.url, {
      method: "POST",
      headers: buildCodexHeaders(this.config.apiKey),
      body: JSON.stringify(body),
      signal: params.abortSignal,
    });

    if (!response.ok) {
      const payload = await response.text();
      throw requestFailure(formatStatusError(response.status, payload), response.status);
    }
    if (!response.body) {
      throw new RequestFailure("Codex response did not include a stream body.");
    }

    const toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];
    const outputPhases = new Map<string, "commentary" | "final_answer">();
    let usage = { inputTokens: 0, outputTokens: 0 };
    let stopReason = "end_turn";

    for await (const event of iterSseEvents(response.body)) {
      const eventType = event.type;
      if (eventType === "response.output_item.added") {
        const item = event.item;
        if (isRecord(item) && typeof item.id === "string") {
          const phase = assistantPhase(item.phase);
          if (phase) outputPhases.set(item.id, phase);
        }
      } else if (eventType === "response.output_text.delta") {
        const delta = event.delta;
        if (typeof delta === "string" && delta) {
          const itemId = typeof event.item_id === "string" ? event.item_id : "";
          const phase = outputPhases.get(itemId);
          yield { type: "text_delta", delta, ...(phase ? { phase } : {}) };
        }
      } else if (eventType === "response.output_item.done") {
        const item = event.item;
        if (!isRecord(item)) continue;
        if (typeof item.id === "string") {
          const phase = assistantPhase(item.phase);
          if (phase) outputPhases.set(item.id, phase);
        }
        if (item.type !== "function_call") continue;
        const callId = typeof item.call_id === "string" ? item.call_id : "";
        const name = typeof item.name === "string" ? item.name : "";
        if (!callId || !name) continue;
        toolCalls.push({
          id: callId,
          name,
          input: parseArguments(item.arguments),
        });
      } else if (eventType === "response.completed") {
        const responsePayload = event.response;
        if (isRecord(responsePayload)) {
          usage = usageFromResponse(responsePayload);
          stopReason = toolCalls.length > 0 ? "tool_use" : "stop";
        }
      } else if (eventType === "response.failed") {
        throw new RequestFailure(formatCodexStreamError(event, "Codex response failed"));
      } else if (eventType === "error") {
        throw new RequestFailure(formatCodexStreamError(event, "Codex error"));
      }
    }

    for (const toolUse of toolCalls) {
      yield {
        type: "tool_use_start",
        toolUse: { type: "tool_use", ...toolUse },
      };
    }

    yield { type: "usage", usage };
    yield { type: "complete", stopReason };
  }

  private classifyError(error: unknown): Error {
    if (error instanceof AuthenticationFailure || error instanceof RateLimitFailure || error instanceof RequestFailure) {
      if (error instanceof RequestFailure) {
        if (error.statusCode === 401 || error.statusCode === 403) {
          return new AuthenticationFailure(error.message);
        }
        if (error.statusCode === 429) {
          return new RateLimitFailure(error.message);
        }
      }
      return error;
    }
    if (error instanceof Error) return error;
    return new Error(String(error));
  }
}

function extractAccountId(token: string): string {
  const payload = decodeJwtPayload(token);
  const authClaim = payload?.[JWT_AUTH_CLAIM];
  if (!isRecord(authClaim)) {
    throw new AuthenticationFailure("Codex access token is missing account metadata.");
  }
  const accountId = authClaim.chatgpt_account_id;
  if (typeof accountId !== "string" || !accountId) {
    throw new AuthenticationFailure("Codex access token is missing chatgpt_account_id.");
  }
  return accountId;
}

async function convertMessagesToCodex(
  messages: Message[],
  signal?: AbortSignal,
): Promise<Array<Record<string, unknown>>> {
  const result: Array<Record<string, unknown>> = [];
  for (const msg of messages) {
    signal?.throwIfAborted();
    if (msg.type === "user") {
      const userContent = await convertUserContent(msg.content, signal);
      if (userContent.length) {
        result.push({ role: "user", content: userContent });
      }
    } else if (msg.type === "assistant") {
      if (msg.content.trim()) {
        result.push({
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: msg.content, annotations: [] }],
          ...(msg.phase ? { phase: msg.phase } : {}),
        });
      }
      for (const toolUse of msg.toolUses ?? []) {
        result.push({
          type: "function_call",
          id: `fc_${toolUse.id.slice(0, 58)}`,
          call_id: toolUse.id,
          name: toolUse.name,
          arguments: JSON.stringify(toolUse.input),
        });
      }
    } else if (msg.type === "tool_result") {
      result.push({
        type: "function_call_output",
        call_id: msg.toolUseId,
        output: msg.content.some((block) => block.type === "image")
          ? await convertUserContent(msg.content, signal)
          : contentBlocksToText(msg.content),
      });
    }
  }
  return result;
}

async function convertUserContent(
  content: string | ContentBlock[],
  signal?: AbortSignal,
): Promise<Array<Record<string, string>>> {
  if (typeof content === "string") {
    return content.trim() ? [{ type: "input_text", text: content }] : [];
  }
  const blocks: Array<Record<string, string>> = [];
  for (const block of content) {
    if (block.type === "text" && block.text.trim()) {
      blocks.push({ type: "input_text", text: block.text });
    } else if (block.type === "image") {
      blocks.push({
        type: "input_image",
        image_url: await imageBlockToDataUrl(block, signal),
      });
    }
  }
  return blocks;
}

async function imageBlockToDataUrl(
  block: Extract<ContentBlock, { type: "image" }>,
  signal?: AbortSignal,
): Promise<string> {
  const prepared = await prepareNativeImagePayload(block, signal);
  assertNativeImageMediaType(prepared.mediaType);
  return preparedImageDataUrl(prepared);
}

function contentBlocksToText(blocks: ContentBlock[]): string {
  return blocks
    .filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function convertToolToCodex(tool: ToolDefinition): Record<string, unknown> {
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
  };
}

async function* iterSseEvents(body: ReadableStream<Uint8Array>): AsyncIterable<Record<string, unknown>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      yield* drainSseBuffer(buffer, (next) => {
        buffer = next;
      });
    }
    buffer += decoder.decode();
    yield* drainSseBuffer(`${buffer}\n\n`, (next) => {
      buffer = next;
    });
  } finally {
    reader.releaseLock();
  }
}

function* drainSseBuffer(
  buffer: string,
  setBuffer: (value: string) => void,
): Iterable<Record<string, unknown>> {
  let cursor = 0;
  while (true) {
    const next = buffer.indexOf("\n\n", cursor);
    if (next === -1) break;
    const frame = buffer.slice(cursor, next);
    cursor = next + 2;
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n")
      .trim();
    if (!data || data === "[DONE]") continue;
    try {
      const parsed = JSON.parse(data) as unknown;
      if (isRecord(parsed)) yield parsed;
    } catch {
      continue;
    }
  }
  setBuffer(buffer.slice(cursor));
}

function parseArguments(value: unknown): Record<string, unknown> {
  if (typeof value !== "string" || !value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function assistantPhase(value: unknown): "commentary" | "final_answer" | undefined {
  return value === "commentary" || value === "final_answer" ? value : undefined;
}

function usageFromResponse(response: Record<string, unknown>): { inputTokens: number; outputTokens: number } {
  const usage = response.usage;
  if (!isRecord(usage)) return { inputTokens: 0, outputTokens: 0 };
  return {
    inputTokens: numberValue(usage.input_tokens),
    outputTokens: numberValue(usage.output_tokens),
  };
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function formatStatusError(status: number, payload: string): string {
  try {
    const parsed = JSON.parse(payload) as unknown;
    if (isRecord(parsed)) {
      const error = parsed.error;
      if (isRecord(error) && typeof error.message === "string" && error.message.trim()) {
        return error.message;
      }
      if (typeof parsed.detail === "string" && parsed.detail.trim()) {
        return parsed.detail;
      }
    }
  } catch {
    // fall through
  }
  return payload.trim() || `Codex request failed with status ${status}`;
}

function formatCodexStreamError(event: Record<string, unknown>, fallback: string): string {
  const error = isRecord(event.error) ? event.error : event;
  const message = typeof error.message === "string" ? error.message : "";
  const code = typeof error.code === "string" ? error.code : "";
  const requestId = typeof error.request_id === "string" ? error.request_id : "";
  const parts = [message || code || fallback];
  if (code) parts.push(`(code=${code})`);
  if (requestId) parts.push(`[request_id=${requestId}]`);
  return parts.join(" ");
}

function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const payload = parts[1]!;
    const padded = payload.padEnd(payload.length + ((4 - payload.length % 4) % 4), "=");
    const parsed = JSON.parse(Buffer.from(padded, "base64url").toString("utf-8")) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

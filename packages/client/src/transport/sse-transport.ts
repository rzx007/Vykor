/**
 * SseTransport: Server-Sent Events 流式传输内核。
 *
 * 负责：
 * - 原始字节流 TextDecoder 解码
 * - SSE 行解析（data:, event:, id:, retry:, 注释行）
 * - 多行 data 拼接（\n 间隔）
 * - CRLF / LF 空行完成单个 frame
 * - signal / abort 支持
 * - Last-Event-ID 透传与错误处理
 */

import type { HttpTransport } from "./http-transport.js";

export interface SseStreamOptions<T = unknown> {
  headers?: RequestInit["headers"];
  signal?: AbortSignal;
  lastEventId?: string;
  decode?: (value: unknown) => T;
  reconnect?: boolean;
  reconnectDelayMs?: number;
  noBodyMessage?: string;
}

export interface SseRawFrame {
  id?: string;
  event?: string;
  data?: string;
  retry?: number;
}

/**
 * 解析单个 SSE frame 的各字段。
 * 符合 W3C SSE 规范：多行 data 以 LF 拼接；以冒号开头的注释行跳过。
 */
export function parseRawSseFrame(frame: string): SseRawFrame | undefined {
  let id: string | undefined;
  let event: string | undefined;
  let retry: number | undefined;
  const dataLines: string[] = [];

  for (const line of frame.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("data:")) {
      dataLines.push(line.startsWith("data: ") ? line.slice(6) : line.slice(5));
    } else if (line.startsWith("event:")) {
      event = (line.startsWith("event: ") ? line.slice(7) : line.slice(6)).trim();
    } else if (line.startsWith("id:")) {
      id = (line.startsWith("id: ") ? line.slice(4) : line.slice(3)).trim();
    } else if (line.startsWith("retry:")) {
      const value = (line.startsWith("retry: ") ? line.slice(7) : line.slice(6)).trim();
      const parsed = parseInt(value, 10);
      if (!Number.isNaN(parsed)) {
        retry = parsed;
      }
    }
  }

  if (dataLines.length === 0 && !id && !event && retry === undefined) {
    return undefined;
  }

  return {
    id,
    event,
    retry,
    data: dataLines.length > 0 ? dataLines.join("\n") : undefined,
  };
}

/** 解析单个 SSE frame 的 `data:` 行，得到事件 JSON。保持原有行为。 */
export function parseSseFrame(frame: string): unknown | undefined {
  let data = "";
  for (const line of frame.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("data:")) {
      const slice = line.slice(5).trimStart();
      data = data ? `${data}\n${slice}` : slice;
    }
  }
  if (!data) return undefined;
  return JSON.parse(data) as unknown;
}

/**
 * 将 SSE 字节流解析为事件异步迭代器。
 * `open` 负责建立连接并返回 response body，便于重试或注入。
 */
export async function* streamServerSentEvents<T>(
  open: () => Promise<ReadableStream<Uint8Array>>,
  decode: (value: unknown) => T = (value) => value as T,
): AsyncIterable<T> {
  const reader = (await open()).getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      // SSE 事件以空行分隔
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const event = parseSseFrame(frame);
        if (event !== undefined) yield decode(event);
      }
    }
    buffer += decoder.decode();
    const event = parseSseFrame(buffer);
    if (event !== undefined) yield decode(event);
  } finally {
    reader.releaseLock();
  }
}

export class SseTransport {
  constructor(private readonly transport: HttpTransport) {}

  streamFromReader<T>(
    open: () => Promise<ReadableStream<Uint8Array>>,
    decode: (value: unknown) => T = (val) => val as T,
  ): AsyncIterable<T> {
    return streamServerSentEvents(open, decode);
  }

  async *stream<T>(
    url: string,
    options: SseStreamOptions<T> = {},
  ): AsyncIterable<T> {
    let lastEventId = options.lastEventId;
    let reconnectDelayMs = options.reconnectDelayMs ?? 250;
    let connected = false;

    while (!options.signal?.aborted) {
      const headers = new Headers(options.headers);
      if (lastEventId) headers.set("Last-Event-ID", lastEventId);
      const requestUrl = connected && lastEventId ? withoutCursor(url) : url;
      const response = await this.transport.requestResponse(
        requestUrl.slice(this.transport.baseUrl.length),
        { headers, signal: options.signal },
      );
      connected = true;
      if (!response.body) {
        throw new Error(options.noBodyMessage ?? "Event stream response has no body");
      }

      for await (const frame of readRawSseFrames(response.body)) {
        if (frame.id !== undefined) lastEventId = frame.id;
        if (frame.retry !== undefined) reconnectDelayMs = frame.retry;
        if (frame.data !== undefined) {
          yield (options.decode ?? ((value) => value as T))(JSON.parse(frame.data));
        }
      }

      if (!options.reconnect || options.signal?.aborted) return;
      await waitForReconnect(reconnectDelayMs, options.signal);
    }
  }
}

async function* readRawSseFrames(
  stream: ReadableStream<Uint8Array>,
): AsyncIterable<SseRawFrame> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() ?? "";
      for (const value of frames) {
        const frame = parseRawSseFrame(value);
        if (frame) yield frame;
      }
    }
    buffer += decoder.decode();
    const frame = parseRawSseFrame(buffer);
    if (frame) yield frame;
  } finally {
    reader.releaseLock();
  }
}

function waitForReconnect(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, Math.max(0, ms));
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal!));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  return new DOMException("Aborted", "AbortError");
}

function withoutCursor(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.delete("cursor");
  return parsed.toString();
}

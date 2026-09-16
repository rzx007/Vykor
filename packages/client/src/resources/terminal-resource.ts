import type {
  TerminalCreateRequest,
  TerminalEvent,
  TerminalReadResult,
  TerminalResizeRequest,
  TerminalSessionInfo,
  TerminalSignal,
  TerminalSource,
  TerminalWriteRequest,
} from "@openharness/protocol";
import {
  decodeTerminalEvent,
  decodeTerminalReadResult,
  decodeTerminalSessionInfo,
} from "@openharness/protocol";
import type { HttpTransport } from "../transport/http-transport.js";
import { responseArray, responseField } from "../transport/http-transport.js";
import type { SseTransport } from "../transport/sse-transport.js";

export class TerminalResource {
  constructor(
    private readonly transport: HttpTransport,
    private readonly sse: SseTransport,
  ) {}

  async create(
    input: TerminalCreateRequest,
    options: { signal?: AbortSignal } = {},
  ): Promise<TerminalSessionInfo> {
    const response = await this.transport.request<unknown>("/terminals", {
      method: "POST",
      body: input,
      signal: options.signal,
    });
    return decodeTerminalSessionInfo(responseField(response, "terminal"));
  }

  async list(
    options: {
      projectId?: string;
      sessionId?: string;
      source?: TerminalSource;
      signal?: AbortSignal;
    } = {},
  ): Promise<TerminalSessionInfo[]> {
    const { signal, ...query } = options;
    const response = await this.transport.request<unknown>(
      this.transport.path("/terminals", query),
      { signal },
    );
    return responseArray(response, "terminals", decodeTerminalSessionInfo);
  }

  async get(
    terminalId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<TerminalSessionInfo> {
    const response = await this.transport.request<unknown>(
      `/terminals/${encodeURIComponent(terminalId)}`,
      { signal: options.signal },
    );
    return decodeTerminalSessionInfo(responseField(response, "terminal"));
  }

  async read(
    terminalId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<TerminalReadResult> {
    const response = await this.transport.request<unknown>(
      `/terminals/${encodeURIComponent(terminalId)}/output`,
      { signal: options.signal },
    );
    return decodeTerminalReadResult(responseField(response, "snapshot"));
  }

  async write(
    input: TerminalWriteRequest,
    options: { signal?: AbortSignal } = {},
  ): Promise<void> {
    await this.transport.request<{ written: true }>(
      `/terminals/${encodeURIComponent(input.terminalId)}/input`,
      { method: "POST", body: { data: input.data }, signal: options.signal },
    );
  }

  async resize(
    input: TerminalResizeRequest,
    options: { signal?: AbortSignal } = {},
  ): Promise<void> {
    await this.transport.request<{ resized: true }>(
      `/terminals/${encodeURIComponent(input.terminalId)}/resize`,
      {
        method: "POST",
        body: { cols: input.cols, rows: input.rows },
        signal: options.signal,
      },
    );
  }

  async signal(
    terminalId: string,
    signal: TerminalSignal,
    options: { signal?: AbortSignal } = {},
  ): Promise<void> {
    await this.transport.request<{ signaled: true }>(
      `/terminals/${encodeURIComponent(terminalId)}/signal`,
      { method: "POST", body: { signal }, signal: options.signal },
    );
  }

  async close(
    terminalId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<void> {
    await this.transport.request<{ removed: true }>(
      `/terminals/${encodeURIComponent(terminalId)}`,
      {
        method: "DELETE",
        signal: options.signal,
      },
    );
  }

  streamEvents(
    options: { signal?: AbortSignal } = {},
  ): AsyncIterable<TerminalEvent> {
    return this.sse.stream(
      this.transport.resolveUrl("/terminals/stream"),
      {
        headers: this.transport.headers(),
        signal: options.signal,
        decode: decodeTerminalEvent,
        noBodyMessage: "Terminal event stream response has no body",
      },
    );
  }
}

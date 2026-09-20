import type { SessionEventRecord } from "@openharness/protocol";
import { decodeSessionEventRecord } from "@openharness/protocol";
import type { HttpTransport } from "../transport/http-transport.js";
import { responseArray } from "../transport/http-transport.js";
import type { SseTransport } from "../transport/sse-transport.js";
import type { EventSyncOptions, ListEventsOptions } from "../types/index.js";

export class EventResource {
  constructor(
    private readonly transport: HttpTransport,
    private readonly sse: SseTransport,
  ) {}

  /** `GET /events` — 用于 attach 时的历史 replay。 */
  async list(
    options: ListEventsOptions & { signal?: AbortSignal } = {},
  ): Promise<SessionEventRecord[]> {
    const { signal, ...query } = options;
    const response = await this.transport.request<unknown>(
      this.transport.path("/events", query),
      { signal },
    );
    return responseArray(response, "events", decodeSessionEventRecord);
  }

  stream(
    options: EventSyncOptions & { transportReconnect?: boolean } = {},
  ): AsyncIterable<SessionEventRecord> {
    const query = {
      cursor: options.cursor,
      sessionId: options.sessionId,
    };
    return this.sse.stream(
      this.transport.resolveUrl("/events/stream", query),
      {
        headers: this.transport.headers(),
        signal: options.signal,
        decode: decodeSessionEventRecord,
        reconnect: options.transportReconnect ?? false,
        idleTimeoutMs: options.idleTimeoutMs,
      },
    );
  }
}

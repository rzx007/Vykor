import { Hono } from "hono";

import type { SessionEventRecord } from "@vykor/protocol";

import type { ApplicationEventService } from "../../application/events/application-event-service.js";
import {
  SSE_HEADERS,
  jsonResponse,
  readCursor,
  readEventCursor,
  readLimit,
} from "../support.js";

interface HttpEventClient {
  controller: ReadableStreamDefaultController<Uint8Array>;
  abort: AbortController;
  heartbeat?: ReturnType<typeof setInterval>;
}

/** 把 Application 的异步事件流翻译成 HTTP SSE；这里不再负责事件分发。 */
export class HttpEventHub {
  private readonly encoder = new TextEncoder();
  private readonly clients = new Set<HttpEventClient>();

  constructor(private readonly events: ApplicationEventService) {}

  get clientCount(): number {
    return this.clients.size;
  }

  createRoutes(): Hono {
    return new Hono()
      .get("/", (c) =>
        jsonResponse({
          events: this.events.list({
            afterSeq: readCursor(c),
            sessionId: c.req.query("sessionId") ?? undefined,
            limit: readLimit(c.req.query("limit")),
          }),
        }),
      )
      .get("/stream", (c) => {
        const abort = new AbortController();
        const requestAbort = () => abort.abort();
        c.req.raw.signal.addEventListener("abort", requestAbort, { once: true });
        const subscription = this.events.subscribe({
          after: readEventCursor(c),
          sessionId: c.req.query("sessionId") ?? undefined,
          signal: abort.signal,
        });
        let client: HttpEventClient | undefined;

        const stream = new ReadableStream<Uint8Array>({
          start: (controller) => {
            client = { controller, abort };
            this.clients.add(client);
            controller.enqueue(this.encoder.encode(": connected\n\n"));
            const heartbeat = setInterval(
              () => this.writeComment(client!, "keepalive"),
              15_000,
            );
            heartbeat.unref?.();
            client.heartbeat = heartbeat;
            void this.pump(client, subscription.stream).finally(() => {
              c.req.raw.signal.removeEventListener("abort", requestAbort);
            });
          },
          cancel: () => {
            if (client) this.removeClient(client);
          },
        });

        return new Response(stream, { status: 200, headers: SSE_HEADERS });
      });
  }

  closeClients(): void {
    for (const client of [...this.clients]) {
      try {
        client.controller.close();
      } catch {
        // Client may already be gone.
      }
      this.removeClient(client);
    }
  }

  private async pump(
    client: HttpEventClient,
    stream: AsyncIterable<SessionEventRecord>,
  ): Promise<void> {
    try {
      for await (const event of stream) {
        client.controller.enqueue(
          this.encoder.encode(
            `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
          ),
        );
      }
    } catch {
      // Broken HTTP clients are normal; aborting removes the Application subscriber.
    } finally {
      this.removeClient(client);
    }
  }

  private writeComment(client: HttpEventClient, comment: string): void {
    try {
      client.controller.enqueue(this.encoder.encode(`: ${comment}\n\n`));
    } catch {
      this.removeClient(client);
    }
  }

  private removeClient(client: HttpEventClient): void {
    if (client.heartbeat) clearInterval(client.heartbeat);
    client.abort.abort();
    this.clients.delete(client);
  }
}

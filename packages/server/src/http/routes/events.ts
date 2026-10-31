import { Hono } from "hono";
import { publicPartEvent } from "../mappers/part-wire-view.js";

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
  heartbeat?: ReturnType<typeof setTimeout>;
  cleanup: () => void;
}

interface PendingEvent {
  outcome?: { next: IteratorResult<SessionEventRecord> } | { error: unknown };
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
          }).map(event => publicPartEvent(event, c.req.query("partView") === "summary")),
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
        const iterator = subscription.stream[Symbol.asyncIterator]();
        let pending: PendingEvent | undefined;
        let wake: (() => void) | undefined;
        let connected = false;

        const stream = new ReadableStream<Uint8Array>({
          start: (controller) => {
            const terminate = () => {
              if (!client || !this.clients.has(client)) return;
              try {
                if (subscription.signal.reason instanceof Error && subscription.signal.reason.name !== "AbortError") {
                  controller.error(subscription.signal.reason);
                } else controller.close();
              } finally { this.removeClient(client); }
            };
            client = { controller, abort, cleanup: () => {
              c.req.raw.signal.removeEventListener("abort", requestAbort);
              subscription.signal.removeEventListener("abort", terminate);
              wake?.();
              wake = undefined;
              pending = undefined;
            } };
            this.clients.add(client);
            subscription.signal.addEventListener("abort", terminate, { once: true });
            if (c.req.raw.signal.aborted) abort.abort();
            if (subscription.signal.aborted) terminate();
          },
          pull: async (controller) => {
            if (!client || !this.clients.has(client)) return;
            if (!connected) {
              connected = true;
              controller.enqueue(this.encoder.encode(": connected\n\n"));
              return;
            }
            try {
              // 每条 next 只注册一次完成处理；心跳只替换当前 read 的唤醒，不给 next 累积回调。
              if (!pending) {
                const current: PendingEvent = {};
                pending = current;
                void iterator.next().then(
                  next => { current.outcome = { next }; wake?.(); },
                  error => { current.outcome = { error }; wake?.(); },
                );
              }
              const current = pending;
              if (!current.outcome) await new Promise<void>(resolve => {
                wake = resolve;
                client!.heartbeat = setTimeout(() => resolve(undefined), 15_000);
                client!.heartbeat.unref?.();
              });
              if (!this.clients.has(client)) return;
              const outcome = current.outcome;
              if (!outcome) {
                controller.enqueue(this.encoder.encode(": keepalive\n\n"));
              } else {
                pending = undefined;
                if ("error" in outcome) throw outcome.error;
                const next = outcome.next;
                if (next.done) { controller.close(); this.removeClient(client); return; }
                const event = next.value;
                controller.enqueue(this.encoder.encode(
                  `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(publicPartEvent(event, c.req.query("partView") === "summary"))}\n\n`,
                ));
              }
            } catch (error) {
              if (this.clients.has(client)) { controller.error(error); this.removeClient(client); }
            } finally {
              wake = undefined;
              if (client.heartbeat) clearTimeout(client.heartbeat);
              client.heartbeat = undefined;
            }
          },
          cancel: () => {
            if (client) this.removeClient(client);
          },
        }, { highWaterMark: 0 });

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

  private removeClient(client: HttpEventClient): void {
    if (client.heartbeat) clearTimeout(client.heartbeat);
    this.clients.delete(client);
    client.cleanup();
    client.abort.abort();
  }
}

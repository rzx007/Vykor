import { SSE_HEADERS } from "../support.js";

interface DesktopHostStream<Event> {
  attach(send: (event: Event) => boolean, close: () => void): string | undefined;
  detach(connectionId: string): void;
}

/** Do not yield queued commands after the host connection has detached. */
export function openDesktopHostStream<Event>(bridge: DesktopHostStream<Event>, signal: AbortSignal): Response | undefined {
  if (signal.aborted) return;
  const encoder = new TextEncoder();
  let connectionId: string | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const queue: string[] = [];
  let wake: (() => void) | undefined;
  const detach = () => { if (connectionId) bridge.detach(connectionId); };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (text: string) => {
        if (queue.length >= 32) return false;
        queue.push(text);
        wake?.();
        return true;
      };
      connectionId = bridge.attach((event) => send(`data: ${JSON.stringify(event)}\n\n`), () => {
        clearInterval(heartbeat);
        signal.removeEventListener("abort", detach);
        queue.length = 0;
        wake?.();
        try { controller.close(); } catch { /* Cancellation can close the response first. */ }
      });
      if (!connectionId) {
        controller.close();
        return;
      }
      heartbeat = setInterval(() => { if (wake) send(": heartbeat\n\n"); }, 15_000);
      heartbeat.unref();
      signal.addEventListener("abort", detach, { once: true });
      if (signal.aborted) detach();
    },
    async pull(controller) {
      if (queue.length === 0) await new Promise<void>((resolve) => { wake = resolve; });
      wake = undefined;
      const next = queue.shift();
      if (next !== undefined) controller.enqueue(encoder.encode(next));
    },
    cancel: detach,
  }, { highWaterMark: 0 });
  if (!connectionId) return;
  return new Response(stream, { headers: { ...SSE_HEADERS, "cache-control": "no-store", connection: "close" } });
}

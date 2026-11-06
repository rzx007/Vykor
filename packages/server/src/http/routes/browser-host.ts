import { Hono } from "hono";
import { BROWSER_BRIDGE_MAX_RESULT_BODY_BYTES, type DesktopBrowserBridge } from "../../application/browser-tools/browser-bridge.js";
import { errorResponse, jsonResponse, SSE_HEADERS } from "../support.js";

export function createBrowserHostRoutes(bridge: DesktopBrowserBridge, available: () => boolean): Hono {
  const encoder = new TextEncoder();
  return new Hono()
    .use("*", async (c, next) => {
      if (!available()) return errorResponse(404, "Desktop browser bridge is unavailable.");
      for (const [name] of c.req.raw.headers) {
        if (name === "origin" || name.startsWith("sec-fetch-")) {
          return errorResponse(403, "Browser host requests must come from Desktop main.");
        }
      }
      await next();
    })
    .get("/stream", (c) => {
      if (bridge.connected) return errorResponse(409, "Desktop browser is already connected.");
      const signal = c.req.raw.signal;
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
            try { controller.close(); } catch { /* Cancellation already closed the stream. */ }
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
      if (!connectionId) return errorResponse(409, "Desktop browser stream is closed.");
      return new Response(stream, { headers: { ...SSE_HEADERS, "cache-control": "no-store", connection: "close" } });
    })
    .post("/:connectionId/:requestId/approval", async (c) => {
      const body = await readBridgeJson(c.req.raw, 32 * 1024);
      if (body instanceof Response) return body;
      const { kind, reason } = body;
      if ((kind !== "origin" && kind !== "developer") || typeof reason !== "string" || !reason.trim() || reason.length > 8_192) {
        return errorResponse(400, "Invalid browser approval request.");
      }
      const approved = await bridge.approve(c.req.param("connectionId"), c.req.param("requestId"), kind, reason, c.req.raw.signal);
      return approved === undefined ? errorResponse(404, "Browser approval request is no longer pending.") : jsonResponse({ approved });
    })
    .post("/:connectionId/:requestId/result", async (c) => {
      const body = await readBridgeJson(c.req.raw, BROWSER_BRIDGE_MAX_RESULT_BODY_BYTES);
      if (body instanceof Response) return body;
      try {
        const completed = bridge.complete(c.req.param("connectionId"), c.req.param("requestId"), body);
        return completed ? jsonResponse({ ok: true }) : errorResponse(404, "Browser request is no longer pending.");
      } catch {
        return errorResponse(400, "Invalid browser result.");
      }
    });
}

async function readBridgeJson(request: Request, limit: number): Promise<Record<string, unknown> | Response> {
  const reader = request.body?.getReader();
  if (!reader) return errorResponse(400, "Missing browser host request body.");
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        void reader.cancel().catch(() => {});
        return errorResponse(413, "Browser host request is too large.");
      }
      chunks.push(value);
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // A broken body or invalid JSON is not a browser response.
  } finally {
    reader.releaseLock();
  }
  return errorResponse(400, "Invalid browser host request body.");
}

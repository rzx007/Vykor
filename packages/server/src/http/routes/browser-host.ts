import { Hono } from "hono";
import { BROWSER_BRIDGE_MAX_RESULT_BODY_BYTES, BROWSER_BRIDGE_RESULT_TOO_LARGE, type DesktopBrowserBridge } from "../../application/browser-tools/browser-bridge.js";
import { errorResponse, isBrowserIssuedRequest, jsonResponse, readDesktopHostJson } from "../support.js";
import { openDesktopHostStream } from "./desktop-host-stream.js";

export function createBrowserHostRoutes(bridge: DesktopBrowserBridge, available: () => boolean): Hono {
  return new Hono()
    .use("*", async (c, next) => {
      if (!available()) return errorResponse(404, "Desktop browser bridge is unavailable.");
      if (isBrowserIssuedRequest(c.req.raw)) {
        return errorResponse(403, "Browser host requests must come from Desktop main.");
      }
      await next();
    })
    .get("/stream", (c) => {
      if (bridge.connected) return errorResponse(409, "Desktop browser is already connected.");
      return openDesktopHostStream(bridge, c.req.raw.signal) ?? errorResponse(409, "Desktop browser stream is closed.");
    })
    .post("/:connectionId/:requestId/approval", async (c) => {
      const body = await readDesktopHostJson(c.req.raw, 32 * 1024, "Browser");
      if (body instanceof Response) return body;
      const { kind, reason } = body;
      if ((kind !== "origin" && kind !== "developer") || typeof reason !== "string" || !reason.trim() || reason.length > 8_192) {
        return errorResponse(400, "Invalid browser approval request.");
      }
      const approved = await bridge.approve(c.req.param("connectionId"), c.req.param("requestId"), kind, reason, c.req.raw.signal);
      return approved === undefined ? errorResponse(404, "Browser approval request is no longer pending.") : jsonResponse({ approved });
    })
    .post("/:connectionId/:requestId/result", async (c) => {
      const { connectionId, requestId } = c.req.param();
      const body = await readDesktopHostJson(c.req.raw, BROWSER_BRIDGE_MAX_RESULT_BODY_BYTES, "Browser");
      if (body instanceof Response) {
        if (body.status === 413) {
          bridge.complete(connectionId, requestId, {
            error: BROWSER_BRIDGE_RESULT_TOO_LARGE,
          });
          // The oversized upload may still have unread bytes on this HTTP socket.
          body.headers.set("connection", "close");
        }
        return body;
      }
      try {
        const completed = bridge.complete(connectionId, requestId, body);
        return completed ? jsonResponse({ ok: true }) : errorResponse(404, "Browser request is no longer pending.");
      } catch {
        return errorResponse(400, "Invalid browser result.");
      }
    });
}

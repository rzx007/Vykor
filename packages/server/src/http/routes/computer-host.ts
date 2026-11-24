import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import type { DesktopComputerBridge } from "../../application/computer-tools/computer-bridge.js";
import { COMPUTER_CAPTURE_MAX_BASE64_BYTES, COMPUTER_HOST_TOKEN_HEADER, parseComputerReply } from "../../application/computer-tools/computer-bridge-protocol.js";
import { errorResponse, isBrowserIssuedRequest, isRecord, jsonResponse, MAX_JSON_BODY_BYTES, readDesktopHostJson } from "../support.js";
import { openDesktopHostStream } from "./desktop-host-stream.js";

// Allow the regular prompt payload plus the session ID and wrapper.
const maxSubmitBytes = MAX_JSON_BODY_BYTES + 2 * 1024;
const maxResultBytes = 64 * 1024;
const maxCaptureResultBytes = maxResultBytes + COMPUTER_CAPTURE_MAX_BASE64_BYTES + 1024;
const maxApprovalBytes = 4 * 1024;

interface ComputerHostRoutesOptions {
  bridge: DesktopComputerBridge;
  token: string;
  available: () => boolean;
  submit(connectionId: string, sessionId: string, input: Record<string, unknown>, request: Request): Promise<Response>;
}

export function createComputerHostRoutes({ bridge, token, available, submit }: ComputerHostRoutesOptions): Hono {
  const secret = /^[a-f0-9]{64}$/.test(token) ? Buffer.from(token, "ascii") : undefined;
  const connectionGone = () => errorResponse(404, "Desktop Computer connection is no longer active.");

  return new Hono()
    .use("*", async (c, next) => {
      if (!available()) return errorResponse(404, "Desktop Computer bridge is unavailable.");
      if (isBrowserIssuedRequest(c.req.raw)) return errorResponse(403, "Computer host requests must come from Desktop main.");
      const token = c.req.header(COMPUTER_HOST_TOKEN_HEADER);
      if (!secret || !token || !/^[a-f0-9]{64}$/.test(token) || !timingSafeEqual(secret, Buffer.from(token, "ascii"))) {
        return errorResponse(401, "Unauthorized");
      }
      await next();
    })
    .get("/stream", (c) =>
      openDesktopHostStream(bridge, c.req.raw.signal) ?? errorResponse(409, "Desktop Computer is already connected or closed."))
    .post("/:connectionId/submit", async (c) => {
      const connectionId = c.req.param("connectionId");
      if (!bridge.connectionSignal(connectionId)) return connectionGone();
      const body = await readDesktopHostJson(c.req.raw, maxSubmitBytes, "Computer");
      if (body instanceof Response) {
        if (body.status === 413) body.headers.set("connection", "close");
        return body;
      }
      if (!bridge.connectionSignal(connectionId)) return connectionGone();
      const { sessionId, input } = body;
      if (typeof sessionId !== "string" || !sessionId.trim() || sessionId.length > 256 || !isRecord(input)
        || Object.keys(body).length !== 2) {
        return errorResponse(400, "Invalid Computer task submission.");
      }
      return await submit(connectionId, sessionId, input, c.req.raw);
    })
    .post("/:connectionId/:requestId/approval", async (c) => {
      const { connectionId, requestId } = c.req.param();
      if (!bridge.connectionSignal(connectionId)) return connectionGone();
      const body = await readDesktopHostJson(c.req.raw, maxApprovalBytes, "Computer");
      if (body instanceof Response) return body;
      const { proposalId, reason, ordinary } = body; // Older Desktop builds may still send ordinary.
      if (Object.keys(body).length !== (ordinary === true ? 3 : 2) || typeof proposalId !== "string"
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(proposalId)
        || typeof reason !== "string" || !reason.trim() || reason.length > 300 || /[\p{Cc}\p{Cf}]/u.test(reason)) {
        return errorResponse(400, "Invalid Computer approval proposal.");
      }
      const approved = await bridge.requestApproval(
        connectionId, requestId, { proposalId, reason: reason.trim() }, c.req.raw.signal,
      );
      return approved === undefined
        ? errorResponse(404, "Computer approval proposal is no longer available.")
        : jsonResponse({ approved, proposalId });
    })
    .post("/:connectionId/approval-reply", async (c) => {
      const { connectionId } = c.req.param();
      if (!bridge.connectionSignal(connectionId)) return connectionGone();
      const body = await readDesktopHostJson(c.req.raw, maxApprovalBytes, "Computer");
      if (body instanceof Response) return body;
      const { requestId, sessionId, status } = body;
      if (Object.keys(body).length !== 3 || typeof requestId !== "string" || !requestId || requestId.length > 256
        || typeof sessionId !== "string" || !sessionId || sessionId.length > 256
        || (status !== "approved" && status !== "denied" && status !== "expired")) {
        return errorResponse(400, "Invalid Computer approval reply.");
      }
      try {
        const request = bridge.replyApproval(connectionId, { requestId, sessionId, status });
        return request
          ? jsonResponse({ request })
          : errorResponse(404, "Computer approval is no longer pending.");
      } catch {
        return errorResponse(409, "Computer approval could not be updated.");
      }
    })
    .post("/:connectionId/:requestId/dispatch", async (c) => {
      const { connectionId, requestId } = c.req.param();
      if (!bridge.connectionSignal(connectionId)) return connectionGone();
      const body = await readDesktopHostJson(c.req.raw, maxApprovalBytes, "Computer");
      if (body instanceof Response) return body;
      if (Object.keys(body).length !== 0) return errorResponse(400, "Invalid Computer dispatch request.");
      return bridge.authorizeDispatch(connectionId, requestId)
        ? jsonResponse({ authorized: true })
        : errorResponse(404, "Computer dispatch authorization is no longer available.");
    })
    .post("/:connectionId/:requestId/revoke-image", async (c) => {
      const { connectionId, requestId } = c.req.param();
      if (!bridge.connectionSignal(connectionId)) return connectionGone();
      const body = await readDesktopHostJson(c.req.raw, maxApprovalBytes, "Computer");
      if (body instanceof Response) return body;
      if (Object.keys(body).length !== 0) return errorResponse(400, "Invalid Computer image revocation.");
      return bridge.revokeImage(connectionId, requestId)
        ? jsonResponse({ ok: true })
        : errorResponse(404, "Computer image is no longer available.");
    })
    .post("/:connectionId/:requestId/result", async (c) => {
      const { connectionId, requestId } = c.req.param();
      if (!bridge.connectionSignal(connectionId)) return connectionGone();
      const body = await readDesktopHostJson(c.req.raw, maxCaptureResultBytes, "Computer");
      if (body instanceof Response) {
        if (body.status === 413) {
          bridge.complete(connectionId, requestId, {
            error: "The Computer result was too large to return.",
            executionState: "unknown",
          });
          body.headers.set("connection", "close");
        }
        return body;
      }
      const reply = parseComputerReply(body);
      if (reply && "result" in reply && Buffer.byteLength(reply.result.text) > maxResultBytes) {
        bridge.complete(connectionId, requestId, { error: "The Computer result was too large to return.", executionState: "unknown" });
        return errorResponse(413, "Computer result exceeds the text byte limit.");
      }
      if (!reply) return errorResponse(400, "Invalid Computer result.");
      return bridge.complete(connectionId, requestId, reply)
        ? jsonResponse({ ok: true })
        : errorResponse(404, "Computer request is no longer pending.");
    });
}

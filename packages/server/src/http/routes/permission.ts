import { Hono } from "hono";
import { parseReplyPermissionRequest } from "@vykor/protocol";

import type { StorePermissionBroker } from "../../permissions/index.js";
import type { RequestTraceRegistry } from "../control/index.js";

import {
  errorResponse,
  jsonResponse,
  protocolValidationErrorResponse,
  readJson,
  readLimit,
  readPermissionStatus,
  type HttpPermissionStatus,
} from "../support.js";

export interface PermissionRoutesContext {
  permissions: Pick<StorePermissionBroker, "listRequests" | "reply">;
  traces: Pick<RequestTraceRegistry, "get">;
}

export function createPermissionRoutes(context: PermissionRoutesContext): Hono {
  return new Hono()
    .get("/", (c) => {
      let status: HttpPermissionStatus | undefined;
      try {
        status = readPermissionStatus(c.req.query("status"));
      } catch (error) {
        return errorResponse(400, error instanceof Error ? error.message : String(error));
      }
      const requests = context.permissions.listRequests({
        sessionId: c.req.query("sessionId") ?? undefined,
        status,
        toolName: c.req.query("toolName") ?? undefined,
        limit: readLimit(c.req.query("limit")),
      });
      return jsonResponse({ requests });
    })
    .post("/:requestId/reply", async (c) => {
      const requestId = c.req.param("requestId");
      if (!requestId) return errorResponse(400, "requestId is required");
      let input;
      try {
        input = parseReplyPermissionRequest(await readJson(c));
      } catch (error) {
        return protocolValidationErrorResponse(error);
      }

      try {
        const request = context.permissions.reply({
          requestId,
          traceId: context.traces.get(c.req.raw),
          ...input,
        });
        return jsonResponse({ request });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return errorResponse(message.includes("not found") ? 404 : 409, message);
      }
    });
}

import { Hono } from "hono";
import type { ReconcileToolOperationRequest } from "@vykor/protocol";
import type { ToolOperationReviewService } from "../../application/session/execution/tool-operation-review-service.js";
import { applicationErrorResponse, errorResponse, jsonResponse, readJson } from "../support.js";

type Review = Pick<ToolOperationReviewService, "list" | "get" | "reconcile">;
/** Mounted under /sessions after the daemon's existing protocol and bearer authentication. */
export function createToolOperationReviewRoutes(review: Review): Hono {
  return new Hono()
    .get("/:sessionId/tool-operations", c => {
      try { return jsonResponse({ operations: review.list(c.req.param("sessionId")) }); }
      catch (error) { return applicationErrorResponse(error); }
    })
    .get("/:sessionId/tool-operations/:operationId", c => {
      try { return jsonResponse({ operation: review.get(c.req.param("sessionId"), c.req.param("operationId")) }); }
      catch (error) { return applicationErrorResponse(error); }
    })
    .post("/:sessionId/tool-operations/:operationId/reconcile", async c => {
      let body;
      try { body = await readJson(c); }
      catch { return errorResponse(400, "A JSON reconciliation request is required"); }
      try { return jsonResponse({ operation: review.reconcile(c.req.param("sessionId"), c.req.param("operationId"), body as unknown as ReconcileToolOperationRequest) }); }
      catch (error) { return applicationErrorResponse(error); }
    });
}

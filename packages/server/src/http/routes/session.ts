import { Hono } from "hono";
import { summarizePart } from "../part-wire-view.js";
import {
  parseCreateSessionRequest,
  parseForkSessionRequest,
  parseUpdateSessionRequest,
  parseClearSessionWorktreeBindingRequest,
} from "@vykor/protocol";

import {
  applicationErrorResponse,
  errorResponse,
  jsonResponse,
  protocolValidationErrorResponse,
  readCursor,
  readJson,
  readLimit,
  sessionMutationErrorStatus,
} from "../support.js";
import type { RequestTraceRegistry } from "../control/index.js";
import type { SessionCommandService } from "../../application/session/session-command-service.js";
import type { SessionInteractionService } from "../../application/session/session-interaction-service.js";
import type { SessionQueryService } from "../../application/session/session-query-service.js";

export interface SessionRoutesContext {
  queries: Pick<
    SessionQueryService,
    | "getSession"
    | "getSessionState"
    | "getMessagePart"
    | "listMessageParts"
    | "listMessages"
    | "listSessions"
    | "searchSessions"
  >;
  commands: Pick<
    SessionCommandService,
    | "archiveSessionTree"
    | "createSession"
    | "deleteSessionTree"
    | "forkSession"
    | "updateSession"
    | "clearWorktreeBinding"
  >;
  interactions: Pick<SessionInteractionService, "warmSession">;
  traces: Pick<RequestTraceRegistry, "get">;
}

export function createSessionRoutes(context: SessionRoutesContext): Hono {
  return new Hono()
    .get("/", (c) => {
      const sessions = context.queries.listSessions({
        cwd: c.req.query("cwd") ?? undefined,
        includeArchived: c.req.query("includeArchived") === "true",
        includeChildren: c.req.query("includeChildren") === "true",
        limit: readLimit(c.req.query("limit")),
      });
      return jsonResponse({ sessions });
    })
    .get("/search", (c) => {
      const query = c.req.query("query") ?? "";
      if (query.length > 256)
        return errorResponse(400, "query must be at most 256 characters");
      return jsonResponse({
        results: context.queries.searchSessions({
          query,
          limit: readLimit(c.req.query("limit")),
        }),
      });
    })
    .post("/", async (c) => {
      let input;
      try {
        input = parseCreateSessionRequest(await readJson(c));
      } catch (error) {
        return protocolValidationErrorResponse(error);
      }
      const session = context.commands.createSession(input);
      return jsonResponse({ session }, 201);
    })
    .get("/:sessionId", async (c) => {
      const sessionId = c.req.param("sessionId");
      if (!sessionId) return errorResponse(400, "sessionId is required");
      const session = await context.interactions.warmSession(sessionId);
      if (!session) return errorResponse(404, "Session not found");
      return jsonResponse({ session });
    })
    .post("/:sessionId/fork", async (c) => {
      const sessionId = c.req.param("sessionId");
      if (!sessionId) return errorResponse(400, "sessionId is required");
      let input;
      try {
        input = parseForkSessionRequest(await readJson(c));
      } catch (error) {
        return protocolValidationErrorResponse(error);
      }
      try {
        const session = context.commands.forkSession(sessionId, input);
        return jsonResponse({ session }, 201);
      } catch (error) {
        return applicationErrorResponse(error, 404);
      }
    })
    .patch("/:sessionId", async (c) => {
      const sessionId = c.req.param("sessionId");
      if (!sessionId) return errorResponse(400, "sessionId is required");
      let input;
      try {
        input = parseUpdateSessionRequest(await readJson(c));
      } catch (error) {
        return protocolValidationErrorResponse(error);
      }
      try {
        const session = await context.commands.updateSession(sessionId, input);
        return jsonResponse({ session });
      } catch (error) {
        return applicationErrorResponse(
          error,
          sessionMutationErrorStatus(error),
        );
      }
    })
    .post("/:sessionId/worktree-cleared", async (c) => {
      let input;
      try { input = parseClearSessionWorktreeBindingRequest(await readJson(c)); }
      catch (error) { return protocolValidationErrorResponse(error); }
      try { return jsonResponse({ session: await context.commands.clearWorktreeBinding(c.req.param("sessionId"), input) }); }
      catch (error) { return applicationErrorResponse(error, sessionMutationErrorStatus(error)); }
    })
    .get("/:sessionId/state", (c) => {
      const sessionId = c.req.param("sessionId");
      if (!sessionId) return errorResponse(400, "sessionId is required");
      try {
        const snapshot = context.queries.getSessionState(sessionId);
        return jsonResponse(c.req.query("partView") === "summary" ? { ...snapshot, parts: snapshot.parts.map(summarizePart) } : snapshot);
      } catch (error) {
        return errorResponse(
          sessionMutationErrorStatus(error),
          error instanceof Error ? error.message : String(error),
        );
      }
    })
    .delete("/:sessionId", async (c) => {
      const sessionId = c.req.param("sessionId");
      if (!sessionId) return errorResponse(400, "sessionId is required");
      try {
        const session = await context.commands.archiveSessionTree(sessionId);
        return jsonResponse({ session });
      } catch (error) {
        return applicationErrorResponse(error, 404);
      }
    })
    .delete("/:sessionId/hard", async (c) => {
      const sessionId = c.req.param("sessionId");
      if (!sessionId) return errorResponse(400, "sessionId is required");
      try {
        const deletedSessionIds =
          await context.commands.deleteSessionTree(sessionId);
        return jsonResponse({ deletedSessionIds });
      } catch (error) {
        return applicationErrorResponse(error, 404);
      }
    })
    .get("/:sessionId/messages", (c) => {
      const sessionId = c.req.param("sessionId");
      if (!sessionId) return errorResponse(400, "sessionId is required");
      try {
        const messages = context.queries.listMessages(sessionId, {
          afterSeq: readCursor(c),
          limit: readLimit(c.req.query("limit")),
        });
        return jsonResponse({ messages });
      } catch (error) {
        return errorResponse(
          404,
          error instanceof Error ? error.message : String(error),
        );
      }
    })
    .get("/:sessionId/parts", (c) => {
      const sessionId = c.req.param("sessionId");
      if (!sessionId) return errorResponse(400, "sessionId is required");
      try {
        const parts = context.queries.listMessageParts(sessionId, {
          afterSeq: readCursor(c),
          messageId: c.req.query("messageId") ?? undefined,
          limit: readLimit(c.req.query("limit")),
        });
        return jsonResponse({ parts: c.req.query("partView") === "summary" ? parts.map(summarizePart) : parts });
      } catch (error) {
        return errorResponse(
          404,
          error instanceof Error ? error.message : String(error),
        );
      }
    })
    .get("/:sessionId/messages/:messageId/parts/:partId", (c) => {
      try {
        const part = context.queries.getMessagePart(c.req.param("sessionId"), c.req.param("messageId"), c.req.param("partId"));
        return part ? jsonResponse({ part }) : errorResponse(404, "Message part unavailable");
      } catch {
        return errorResponse(404, "Message part unavailable");
      }
    });
}

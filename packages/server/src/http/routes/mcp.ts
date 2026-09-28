import type {
  McpRuntimeConnectionCoordinator,
  McpServerIdentity,
} from "@vykor/core";
import {
  MCP_OAUTH_LOGIN_COMPLETED_EVENT,
  parseMcpOAuthCallbackInput,
  parseMcpOAuthLoginInput,
  type OAuthOperationEvent,
} from "@vykor/protocol";
import { Hono, type Context } from "hono";

import {
  McpOAuthApplicationError,
  type McpOAuthApplicationService,
} from "../../application/mcp-oauth-application-service.js";
import {
  McpOAuthOperationError,
  type McpOAuthOperationService,
} from "../../application/mcp-oauth-operation-service.js";
import { errorResponse, jsonResponse, readJson, type JsonRecord } from "../support.js";

export interface McpRoutesContext {
  runtimes: McpRuntimeConnectionCoordinator;
  /** Optional for Runtime-only embeddings/tests. */
  oauth?: Pick<McpOAuthApplicationService, "snapshot" | "logout">;
  operations?: McpOAuthOperationService;
}

const FINGERPRINT_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * MCP Runtime control plane and OAuth login operations.
 *
 * Both endpoints carry only the server name and the endpoint fingerprint. The
 * full endpoint (and its query) stays inside the participating Runtime, and no
 * token or Authorization header is accepted or returned. Requests inherit the
 * server-wide protocol-version and Bearer middleware.
 */
export function createMcpRoutes(context: McpRoutesContext): Hono {
  const app = new Hono();
  const noStore = (response: Response): Response => {
    response.headers.set("cache-control", "no-store");
    return response;
  };

  app.get("/oauth/status", async () => {
    const oauth = requireOAuth(context);
    if (oauth instanceof Response) return oauth;
    return noStore(jsonResponse(await oauth.snapshot()));
  });

  app.post("/oauth/operations/:loginId/callback", async (c) => {
    if (!context.operations) return errorResponse(501, "MCP OAuth operations are not configured");
    const body: JsonRecord = await readJson(c).catch(() => ({}));
    let input;
    try {
      input = parseMcpOAuthCallbackInput(body);
    } catch (error) {
      return errorResponse(400, safeMessage(error));
    }
    try {
      return noStore(jsonResponse(await context.operations.submitCallback(c.req.param("loginId"), input.callbackUrl)));
    } catch (error) {
      return operationErrorResponse(error);
    }
  });

  app.get("/oauth/operations/:loginId", (c) => {
    if (!context.operations) return errorResponse(501, "MCP OAuth operations are not configured");
    const view = context.operations.get(c.req.param("loginId"));
    if (!view) return errorResponse(404, "MCP OAuth operation was not found");
    const authorizationUrl = context.operations.authorizationUrl(view.loginId);
    return noStore(jsonResponse({ ...view, ...(authorizationUrl ? { authorizationUrl } : {}) }));
  });

  app.get("/oauth/operations/:loginId/events", (c) => {
    if (!context.operations) return errorResponse(501, "MCP OAuth operations are not configured");
    const loginId = c.req.param("loginId");
    if (!context.operations.get(loginId)) return errorResponse(404, "MCP OAuth operation was not found");
    return noStore(operationEventStream(context.operations, loginId, c));
  });

  app.delete("/oauth/operations/:loginId", async (c) => {
    if (!context.operations) return errorResponse(501, "MCP OAuth operations are not configured");
    const view = await context.operations.cancel(c.req.param("loginId"));
    if (!view) return errorResponse(404, "MCP OAuth operation was not found");
    return noStore(jsonResponse(view));
  });

  app.post("/:name/oauth/login", async (c) => {
    if (!context.operations) return errorResponse(501, "MCP OAuth operations are not configured");
    const body: JsonRecord = await readJson(c).catch(() => ({}));
    let input;
    try {
      input = parseMcpOAuthLoginInput(body);
    } catch (error) {
      return errorResponse(400, safeMessage(error));
    }
    try {
      const result = context.operations.begin({
        oauthInstanceId: input.oauthInstanceId,
        requestId: input.requestId,
        name: c.req.param("name"),
        ...(input.scopes ? { scopes: input.scopes } : {}),
        callbackMode: input.callbackMode,
      });
      return noStore(jsonResponse({ loginId: result.view.loginId, operation: result.view }, 202));
    } catch (error) {
      return operationErrorResponse(error);
    }
  });

  app.post("/:name/oauth/logout", async (c) => {
    const oauth = requireOAuth(context);
    if (oauth instanceof Response) return oauth;
    try {
      await oauth.logout(c.req.param("name"));
    } catch (error) {
      if (error instanceof McpOAuthApplicationError && error.code === "oauth-removed-runtime-sync-failed") {
        return noStore(jsonResponse({
          error: "MCP OAuth credentials were removed, but runtime synchronization failed",
          code: error.code,
          credentialRemoved: true,
        }, 500));
      }
      return noStore(errorResponse(500, "MCP OAuth logout failed"));
    }
    return noStore(jsonResponse(await oauth.snapshot()));
  });

  app.get("/:name/runtime-status", async (c) => {
    const fingerprint = c.req.query("fingerprint");
    if (!isFingerprint(fingerprint)) {
      return errorResponse(400, "A valid endpoint fingerprint is required");
    }
    const identity = identityFor(c.req.param("name"), fingerprint);
    return jsonResponse(await context.runtimes.getStatus(identity));
  });

  app.post("/:name/synchronize", async (c) => {
    const body: JsonRecord = await readJson(c).catch(() => ({}));
    const fingerprint = typeof body.fingerprint === "string" ? body.fingerprint : undefined;
    if (!isFingerprint(fingerprint)) {
      return errorResponse(400, "A valid endpoint fingerprint is required");
    }
    const identity = identityFor(c.req.param("name"), fingerprint);
    return jsonResponse(await context.runtimes.synchronize(identity));
  });

  app.post("/:name/reconcile-global", async (c) => {
    return jsonResponse(await context.runtimes.reconcileGlobal(c.req.param("name")));
  });

  return app;
}

function requireOAuth(
  context: McpRoutesContext,
): Pick<McpOAuthApplicationService, "snapshot" | "logout"> | Response {
  if (!context.oauth) return errorResponse(501, "MCP OAuth is not configured");
  return context.oauth;
}

function operationEventStream(
  operations: McpOAuthOperationService,
  loginId: string,
  c: Context,
): Response {
  const encoder = new TextEncoder();
  let cleanup = () => undefined;
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        let unsubscribe: (() => void) | undefined;
        let closed = false;
        cleanup = () => {
          if (closed) return;
          closed = true;
          c.req.raw.signal.removeEventListener("abort", close);
          unsubscribe?.();
        };
        const close = () => {
          cleanup();
          try {
            controller.close();
          } catch {
            // Already closed.
          }
        };
        const send = (event: OAuthOperationEvent) => {
          if (closed) return;
          // The SSE event name carries the type; the payload repeats the full
          // safe event so a client can validate without trusting the name.
          controller.enqueue(encoder.encode(`event: ${event.event}\ndata: ${JSON.stringify(event)}\n\n`));
          if (event.event === MCP_OAUTH_LOGIN_COMPLETED_EVENT) close();
        };
        c.req.raw.signal.addEventListener("abort", close, { once: true });
        if (c.req.raw.signal.aborted) { close(); return; }
        unsubscribe = operations.subscribe(loginId, send);
        // A terminal snapshot can close synchronously during subscribe().
        if (closed) unsubscribe();
      },
      cancel() { cleanup(); },
    }),
    {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        connection: "keep-alive",
      },
    },
  );
}

function operationErrorResponse(error: unknown): Response {
  if (error instanceof McpOAuthOperationError) {
    const status =
      error.code === "oauth-operation-not-found" ? 404
      : error.code === "oauth-operation-busy" || error.code === "oauth-operation-limit" ? 429
      : error.code === "oauth-callback-not-manual" || error.code === "oauth-callback-invalid" ? 400
      : error.code === "oauth-operation-closing" ? 503
      : 409;
    return errorResponse(status, error.message);
  }
  return errorResponse(500, safeMessage(error));
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Invalid MCP OAuth request";
}

function isFingerprint(value: unknown): value is string {
  return typeof value === "string" && FINGERPRINT_PATTERN.test(value);
}

function identityFor(name: string, endpointFingerprint: string): McpServerIdentity {
  // The control plane never receives the endpoint; each Runtime supplies its
  // own normalized endpoint for the same fingerprint.
  return { name, transport: "http", endpoint: "", endpointFingerprint };
}

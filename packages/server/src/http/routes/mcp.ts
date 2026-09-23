import type {
  McpRuntimeConnectionCoordinator,
  McpServerIdentity,
} from "@openharness/core";
import { Hono } from "hono";

import { errorResponse, jsonResponse, readJson, type JsonRecord } from "../support.js";

export interface McpRoutesContext {
  runtimes: McpRuntimeConnectionCoordinator;
}

const FINGERPRINT_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * MCP Runtime control plane.
 *
 * Both endpoints carry only the server name and the endpoint fingerprint. The
 * full endpoint (and its query) stays inside the participating Runtime, and no
 * token or Authorization header is accepted or returned. Requests inherit the
 * server-wide protocol-version and Bearer middleware.
 */
export function createMcpRoutes(context: McpRoutesContext): Hono {
  return new Hono()
    .get("/:name/runtime-status", async (c) => {
      const fingerprint = c.req.query("fingerprint");
      if (!isFingerprint(fingerprint)) {
        return errorResponse(400, "A valid endpoint fingerprint is required");
      }
      const identity = identityFor(c.req.param("name"), fingerprint);
      return jsonResponse(await context.runtimes.getStatus(identity));
    })
    .post("/:name/synchronize", async (c) => {
      const body: JsonRecord = await readJson(c).catch(() => ({}));
      const fingerprint = typeof body.fingerprint === "string" ? body.fingerprint : undefined;
      if (!isFingerprint(fingerprint)) {
        return errorResponse(400, "A valid endpoint fingerprint is required");
      }
      const identity = identityFor(c.req.param("name"), fingerprint);
      return jsonResponse(await context.runtimes.synchronize(identity));
    })
    .post("/:name/reconcile-global", async (c) => {
      return jsonResponse(await context.runtimes.reconcileGlobal(c.req.param("name")));
    });
}

function isFingerprint(value: unknown): value is string {
  return typeof value === "string" && FINGERPRINT_PATTERN.test(value);
}

function identityFor(name: string, endpointFingerprint: string): McpServerIdentity {
  // The control plane never receives the endpoint; each Runtime supplies its
  // own normalized endpoint for the same fingerprint.
  return { name, transport: "http", endpoint: "", endpointFingerprint };
}

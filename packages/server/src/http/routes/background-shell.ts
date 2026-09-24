import { randomUUID } from "node:crypto";

import { Hono } from "hono";

import type { JobReadResult } from "@vykor/protocol";

import type { BackgroundShellService } from "../../application/session/background-shell-service.js";
import {
  applicationErrorResponse,
  errorResponse,
  jsonResponse,
  readJson,
} from "../support.js";

export interface BackgroundShellRoutesContext {
  backgroundShells: Pick<BackgroundShellService, "create" | "stop">;
  jobs: { read(input: { sessionId: string; jobId: string }): Promise<JobReadResult> };
}

export function createBackgroundShellRoutes(context: BackgroundShellRoutesContext): Hono {
  return new Hono().post("/", async (c) => {
    const body = await readJson(c);
    const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
    const command = typeof body.command === "string" ? body.command.trim() : "";
    if (!sessionId) return errorResponse(400, "sessionId is required");
    if (!command) return errorResponse(400, "command is required");
    let execution: Awaited<ReturnType<BackgroundShellService["create"]>>["execution"];
    let created = false;
    try {
      ({ execution, created } = await context.backgroundShells.create({
        requestId: httpRequestId(c.req.header("Idempotency-Key"), body.requestId),
        sessionId,
        cwd: typeof body.cwd === "string" ? body.cwd : undefined,
        command,
        description: typeof body.description === "string" ? body.description : undefined,
      }));
    } catch (error) {
      return applicationErrorResponse(error);
    }

    try {
      const result = await context.jobs.read({ sessionId, jobId: execution.id });
      return jsonResponse({ jobId: execution.id, snapshot: result.snapshot }, 201);
    } catch (error) {
      if (created) {
        try {
          await context.backgroundShells.stop(execution.id, { sessionId });
        } catch (cleanupError) {
          return errorResponse(
            500,
            `Failed to normalize created background Job ${execution.id}: ${errorMessage(error)}; ` +
            `cleanup failed: ${errorMessage(cleanupError)}`,
          );
        }
      }
      return errorResponse(500, errorMessage(error));
    }
  });
}

function httpRequestId(headerValue: string | undefined, bodyValue: unknown): string {
  const supplied = headerValue?.trim() || (typeof bodyValue === "string" ? bodyValue.trim() : "");
  return `http:${supplied || randomUUID()}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

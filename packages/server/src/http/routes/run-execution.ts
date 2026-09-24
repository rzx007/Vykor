import { Hono } from "hono";
import {
  parseAdmitPromptRequest,
  parsePromptAttachments,
  parsePromptItems,
} from "@vykor/protocol";

import {
  applicationErrorResponse,
  errorResponse,
  isRecord,
  jsonResponse,
  protocolValidationErrorResponse,
  readJson,
  sessionMutationErrorStatus,
} from "../support.js";
import type { RequestTraceRegistry } from "../control/index.js";
import type { SessionInteractionService } from "../../application/session/session-interaction-service.js";

export interface RunExecutionRoutesContext {
  application: Pick<
    SessionInteractionService,
    | "admitPrompt"
    | "cancelQueuedPrompt"
    | "editLatestPrompt"
    | "interruptSession"
    | "promoteQueuedPrompt"
    | "resumeRun"
  >;
  traces: Pick<RequestTraceRegistry, "get">;
}

export function createRunExecutionRoutes(
  context: RunExecutionRoutesContext,
): Hono {
  return new Hono()
    .post("/:sessionId/prompts", async (c) => {
      const sessionId = c.req.param("sessionId");
      if (!sessionId) return errorResponse(400, "sessionId is required");
      let input;
      try {
        input = parseAdmitPromptRequest(await readJson(c));
      } catch (error) {
        return protocolValidationErrorResponse(error);
      }

      try {
        const admitted = await context.application.admitPrompt(sessionId, {
          ...input,
          traceId: context.traces.get(c.req.raw),
        });
        return jsonResponse(admitted, 202);
      } catch (error) {
        return applicationErrorResponse(
          error,
          sessionMutationErrorStatus(error),
        );
      }
    })
    .post("/:sessionId/prompts/latest/edit", async (c) => {
      const sessionId = c.req.param("sessionId");
      if (!sessionId) return errorResponse(400, "sessionId is required");
      let body;
      let attachments;
      let items;
      try {
        body = await readJson(c);
        attachments = parsePromptAttachments(body.attachments);
        items = parsePromptItems(body);
      } catch (error) {
        return protocolValidationErrorResponse(error);
      }
      if (typeof body.id !== "string" || !body.id.trim())
        return errorResponse(400, "id is required");
      if (
        typeof body.sourceMessageId !== "string" ||
        !body.sourceMessageId.trim()
      )
        return errorResponse(400, "sourceMessageId is required");
      if (body.metadata !== undefined && !isRecord(body.metadata))
        return errorResponse(400, "metadata must be an object");

      try {
        const admitted = await context.application.editLatestPrompt(sessionId, {
          id: body.id,
          items,
          sourceMessageId: body.sourceMessageId,
          attachments,
          ...(isRecord(body.metadata) ? { metadata: body.metadata } : {}),
          traceId: context.traces.get(c.req.raw),
        });
        return jsonResponse(admitted, 202);
      } catch (error) {
        return applicationErrorResponse(
          error,
          sessionMutationErrorStatus(error),
        );
      }
    })
    .post("/:sessionId/prompts/:inputId/promote", async (c) => {
      const sessionId = c.req.param("sessionId");
      const inputId = c.req.param("inputId");
      if (!sessionId || !inputId)
        return errorResponse(400, "sessionId and inputId are required");
      const body = await readJson(c);
      if (typeof body.queuedRunId !== "string" || !body.queuedRunId.trim())
        return errorResponse(400, "queuedRunId is required");
      if (
        typeof body.expectedActiveRunId !== "string" ||
        !body.expectedActiveRunId.trim()
      )
        return errorResponse(400, "expectedActiveRunId is required");
      try {
        return jsonResponse(
          await context.application.promoteQueuedPrompt(sessionId, inputId, {
            queuedRunId: body.queuedRunId,
            expectedActiveRunId: body.expectedActiveRunId,
          }),
          200,
        );
      } catch (error) {
        return applicationErrorResponse(
          error,
          sessionMutationErrorStatus(error),
        );
      }
    })
    .post("/:sessionId/prompts/:inputId/cancel", async (c) => {
      const sessionId = c.req.param("sessionId");
      const inputId = c.req.param("inputId");
      if (!sessionId || !inputId)
        return errorResponse(400, "sessionId and inputId are required");
      const body = await readJson(c);
      if (typeof body.queuedRunId !== "string" || !body.queuedRunId.trim())
        return errorResponse(400, "queuedRunId is required");
      try {
        return jsonResponse(
          await context.application.cancelQueuedPrompt(sessionId, inputId, {
            queuedRunId: body.queuedRunId,
          }),
          200,
        );
      } catch (error) {
        return applicationErrorResponse(
          error,
          sessionMutationErrorStatus(error),
        );
      }
    })
    .post("/:sessionId/runs/:runId/resume", async (c) => {
      const sessionId = c.req.param("sessionId");
      const runId = c.req.param("runId");
      if (!sessionId || !runId)
        return errorResponse(400, "sessionId and runId are required");
      const body = await readJson(c);
      if (body.id !== undefined && typeof body.id !== "string")
        return errorResponse(400, "id must be a string");
      if (body.metadata !== undefined && !isRecord(body.metadata))
        return errorResponse(400, "metadata must be an object");

      try {
        const resumed = await context.application.resumeRun(sessionId, runId, {
          id: typeof body.id === "string" ? body.id : undefined,
          metadata: isRecord(body.metadata) ? body.metadata : undefined,
          traceId: context.traces.get(c.req.raw),
        });
        return jsonResponse(resumed, 202);
      } catch (error) {
        return applicationErrorResponse(
          error,
          sessionMutationErrorStatus(error),
        );
      }
    })
    .post("/:sessionId/interrupt", async (c) => {
      const sessionId = c.req.param("sessionId");
      if (!sessionId) return errorResponse(400, "sessionId is required");
      const body = await readJson(c);
      if (
        body.expectedRunId !== undefined &&
        (typeof body.expectedRunId !== "string" || !body.expectedRunId.trim())
      ) {
        return errorResponse(400, "expectedRunId must be a non-empty string");
      }
      const expectedRunId = body.expectedRunId as string | undefined;
      return jsonResponse(
        await context.application.interruptSession(sessionId, expectedRunId),
      );
    });
}

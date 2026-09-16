import {
  ProtocolValidationError,
  PROTOCOL_VERSION_HEADER,
  type ProtocolError,
} from "@openharness/protocol";
import type { Context } from "hono";
import {
  isAttachmentError,
  type AttachmentErrorCode,
} from "@openharness/services";
import {
  APPLICATION_ERROR_HTTP_STATUS,
  ApplicationError,
} from "../shared/application-error.js";
export {
  DAEMON_RESTART_INPUT_REASON,
  DAEMON_RESTART_PERMISSION_REASON,
  DAEMON_RESTART_RUN_REASON,
  DAEMON_RESTART_TASK_REASON,
  DAEMON_RESTART_WORKFLOW_REASON,
  countByStatus,
  jsonEqual,
  normalizeTraceId,
  runtimeSessionMetadataChanged,
  withoutTraceId,
  workflowRunIdFromSessionEvent,
  type OpenHarnessRuntimeSnapshot,
} from "../application/support.js";

export type JsonRecord = Record<string, unknown>;

export type HttpPermissionStatus = "pending" | "approved" | "denied" | "expired";

export interface OpenHarnessServerHealth {
  ok: true;
  version?: string;
  startedAt: number;
  uptimeMs: number;
  sessionCount: number;
  activeRunCount: number;
  queuedRunCount: number;
}

export type SseClient = {
  sessionId?: string;
  controller: ReadableStreamDefaultController<Uint8Array>;
  heartbeat?: ReturnType<typeof setInterval>;
};

export const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
export const SSE_HEADERS = {
  "cache-control": "no-cache",
  "connection": "keep-alive",
  "content-type": "text/event-stream; charset=utf-8",
};
export const CORS_METHODS = "GET, POST, PATCH, DELETE, OPTIONS";
export const CORS_HEADERS =
  `authorization, content-type, last-event-id, x-openharness-filename, x-openharness-trace-id, range, if-none-match, ${PROTOCOL_VERSION_HEADER}`;
export const CORS_EXPOSE_HEADERS =
  "x-openharness-trace-id, content-range, content-disposition, etag, accept-ranges";

export function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function normalizeAllowedOrigins(origins: readonly string[]): Set<string> {
  const normalized = new Set<string>();
  for (const value of origins) {
    if (value === "*") throw new Error("Wildcard CORS origins are not supported");
    let origin: URL;
    try {
      origin = new URL(value);
    } catch {
      throw new Error(`Invalid allowed origin: ${value}`);
    }
    if ((origin.protocol !== "http:" && origin.protocol !== "https:") || origin.origin !== value.replace(/\/$/, "")) {
      throw new Error(`Allowed origin must be an http(s) origin without a path: ${value}`);
    }
    normalized.add(origin.origin);
  }
  return normalized;
}

export function readLimit(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function readCursor(c: Context): number | undefined {
  return readLimit(c.req.query("cursor") ?? c.req.query("afterSeq"));
}

export function readEventCursor(c: Context): number | undefined {
  return readCursor(c) ?? readLimit(c.req.header("last-event-id"));
}

export function readPermissionStatus(value: string | undefined): HttpPermissionStatus | undefined {
  if (!value) return undefined;
  if (value === "pending" || value === "approved" || value === "denied" || value === "expired") return value;
  throw new Error("Invalid permission status");
}

export function jsonResponse(body: unknown, status = 200): Response {
  const text = JSON.stringify(body);
  return new Response(text, {
    status,
    headers: {
      ...JSON_HEADERS,
      "content-length": String(Buffer.byteLength(text)),
    },
  });
}

export function errorResponse(status: number, message: string): Response {
  return jsonResponse({ error: message }, status);
}

const ATTACHMENT_ERROR_HTTP_STATUS = {
  attachment_invalid_request: 400,
  attachment_too_large: 413,
  attachment_not_found: 404,
  attachment_not_ready: 409,
  attachment_aborted: 408,
  attachment_storage_failed: 500,
  prompt_content_required: 400,
  attachment_duplicate_reference: 400,
  prompt_id_conflict: 409,
  attachment_in_use: 409,
  attachment_structured_steer_unsupported: 409,
  attachment_count_exceeded: 413,
  attachment_prompt_size_exceeded: 413,
  attachment_session_size_exceeded: 413,
} as const satisfies Record<AttachmentErrorCode, number>;

export function attachmentErrorResponse(error: unknown): Response {
  if (!isAttachmentError(error)) {
    return errorResponse(500, "Attachment request failed");
  }
  return errorResponse(ATTACHMENT_ERROR_HTTP_STATUS[error.code], error.message);
}

/** Application error code 到 HTTP status 的唯一转换位置。 */
export function applicationErrorResponse(
  error: unknown,
  fallbackStatus = 500,
): Response {
  if (isAttachmentError(error)) return attachmentErrorResponse(error);
  const status =
    error instanceof ApplicationError
      ? APPLICATION_ERROR_HTTP_STATUS[error.code]
      : fallbackStatus;
  return errorResponse(
    status,
    error instanceof Error ? error.message : String(error),
  );
}

export function protocolValidationErrorResponse(error: unknown): Response {
  const validationError = error instanceof ProtocolValidationError
    ? error
    : new ProtocolValidationError(
      error instanceof SyntaxError
        ? "Request body must be valid JSON"
        : error instanceof Error
          ? error.message
          : String(error),
    );
  return jsonResponse(validationError.toProtocolError() satisfies ProtocolError, 400);
}

export function sessionMutationErrorStatus(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith("Session is archived:") ||
    message.startsWith("Session is closing:") ||
    message.startsWith("Prompt id is already used:")
    ? 409
    : 404;
}

export async function readJson(c: Context): Promise<JsonRecord> {
  const text = await c.req.text();
  if (!text.trim()) return {};
  if (new TextEncoder().encode(text).byteLength > 1024 * 1024) {
    throw new ProtocolValidationError("Request body too large");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new ProtocolValidationError("Request body must be valid JSON");
  }
  if (!isRecord(parsed)) {
    throw new ProtocolValidationError("Request body must be a JSON object");
  }
  return parsed;
}

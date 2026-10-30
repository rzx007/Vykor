import { Hono } from "hono";
import {
  SessionFileError, parseSessionFileListInput, parseSessionFileStatInput,
  parseSessionFileReadInput, parseSessionFileFindInput, parseSessionFileSearchInput,
  type SessionFileErrorCode,
} from "@vykor/protocol";
import type { SessionFileService } from "../../application/files/session-file-service.js";
import { jsonResponse } from "../support.js";

export type SessionFileRouteService = Pick<SessionFileService, "list" | "stat" | "readText" | "find" | "search">;

const errorStatuses: Record<SessionFileErrorCode, number> = {
  file_invalid_request: 400,
  file_forbidden: 403,
  file_not_found: 404,
  file_not_text: 415,
  file_not_ready: 503,
  file_not_supported: 501,
  file_timeout: 408,
  file_cancelled: 408,
  file_operation_failed: 500,
};

/** HTTP validates queries; the application owns workspace selection and authorization. */
export function createSessionFileRoutes(files?: SessionFileRouteService): Hono {
  async function respond(work: (service: SessionFileRouteService) => Promise<unknown>): Promise<Response> {
    if (!files) return jsonResponse({ code: "file_not_supported", message: "Session file service is not configured" }, 501);
    try {
      return jsonResponse(await work(files));
    } catch (error) {
      if (error instanceof SessionFileError && Object.hasOwn(errorStatuses, error.code)) {
        return jsonResponse({ code: error.code, message: error.message }, errorStatuses[error.code]);
      }
      return jsonResponse({ code: "file_operation_failed", message: "File operation failed" }, 500);
    }
  }

  return new Hono()
    .get("/:sessionId/files", c => respond(service => {
      const query = parseSessionFileListInput(readQuery(c.req.url));
      return service.list(c.req.param("sessionId"), { ...query, signal: c.req.raw.signal });
    }))
    .get("/:sessionId/files/stat", c => respond(service => {
      const { path } = parseSessionFileStatInput(readQuery(c.req.url));
      return service.stat(c.req.param("sessionId"), path, { signal: c.req.raw.signal });
    }))
    .get("/:sessionId/files/text", c => respond(service => {
      const { path, ...options } = parseSessionFileReadInput(readQuery(c.req.url));
      return service.readText(c.req.param("sessionId"), path, { ...options, signal: c.req.raw.signal });
    }))
    .get("/:sessionId/files/find", c => respond(service => {
      const query = parseSessionFileFindInput(readQuery(c.req.url));
      return service.find(c.req.param("sessionId"), { ...query, signal: c.req.raw.signal });
    }))
    .get("/:sessionId/files/search", c => respond(service => {
      const query = parseSessionFileSearchInput(readQuery(c.req.url));
      return service.search(c.req.param("sessionId"), { ...query, signal: c.req.raw.signal });
    }));
}

function readQuery(url: string): Record<string, string> {
  const query = Object.create(null) as Record<string, string>;
  for (const [name, value] of new URL(url).searchParams) {
    if (Object.hasOwn(query, name)) throw new SessionFileError("file_invalid_request", "Repeated file query fields are not allowed");
    query[name] = value;
  }
  return query;
}

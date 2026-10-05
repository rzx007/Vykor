import {
  parseCreateNoteInput,
  parseUpdateNoteInput,
  ProtocolValidationError,
} from "@vykor/protocol";
import {
  NoteRevisionConflictError,
  type NoteRepository,
} from "@vykor/services";
import { Hono } from "hono";

import {
  errorResponse,
  jsonResponse,
  protocolValidationErrorResponse,
  readJson,
} from "../support.js";

export interface NoteRoutesContext {
  notes: Pick<NoteRepository, "list" | "create" | "update" | "remove"> &
    Partial<Pick<NoteRepository, "storageInfo">>;
}

export function createNoteRoutes(context: NoteRoutesContext): Hono {
  return new Hono()
    .get("/storage", () => {
      try {
        if (!context.notes.storageInfo)
          return errorResponse(503, "便签存储尚未就绪");
        return jsonResponse(context.notes.storageInfo());
      } catch (error) {
        return noteError(error);
      }
    })
    .get("/", () => {
      try {
        return jsonResponse({ notes: context.notes.list() });
      } catch (error) {
        return noteError(error);
      }
    })
    .post("/", async (c) => {
      try {
        const input = parseCreateNoteInput(await readJson(c));
        return jsonResponse({ note: context.notes.create(input) }, 201);
      } catch (error) {
        return noteError(error);
      }
    })
    .patch("/:id", async (c) => {
      try {
        const input = parseUpdateNoteInput(await readJson(c));
        return jsonResponse({
          note: context.notes.update(c.req.param("id"), input),
        });
      } catch (error) {
        return noteError(error);
      }
    })
    .delete("/:id", (c) => {
      try {
        if (!context.notes.remove(c.req.param("id"))) {
          return errorResponse(404, `Note not found: ${c.req.param("id")}`);
        }
        return jsonResponse({ removed: true });
      } catch (error) {
        return noteError(error);
      }
    });
}

function noteError(error: unknown): Response {
  if (
    error instanceof ProtocolValidationError ||
    error instanceof SyntaxError
  ) {
    return protocolValidationErrorResponse(error);
  }
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof NoteRevisionConflictError)
    return errorResponse(409, message);
  if (message.includes("Note not found")) return errorResponse(404, message);
  return errorResponse(500, message);
}

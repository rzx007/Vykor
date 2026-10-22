import {
  NoteRevisionConflictError,
  type NoteRepository,
} from "@vykor/services";
import {
  ProtocolValidationError,
  type CreateNoteInput,
  type UpdateNoteInput,
} from "@vykor/protocol";
import { ApplicationError } from "../../shared/application-error.js";
export interface NoteApplicationContext {
  notes: Pick<NoteRepository, "list" | "create" | "update" | "remove"> &
    Partial<Pick<NoteRepository, "storageInfo">>;
  readiness?(): { phase: string; accepting: boolean };
}
export function createNoteApplicationService(context: NoteApplicationContext) {
  function call<T>(write: boolean, operation: () => T): T {
    const state = context.readiness?.();
    if (write && state && (state.phase !== "ready" || !state.accepting))
      throw new ApplicationError(
        409,
        "后台尚未就绪或已停止准入，拒绝便签写操作",
      );
    try {
      return operation();
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new ApplicationError(
        error instanceof ProtocolValidationError
          ? 400
          : error instanceof NoteRevisionConflictError
            ? 409
            : message.includes("Note not found")
              ? 404
              : 500,
        message,
      );
    }
  }
  return {
    list: () => call(false, () => context.notes.list()),
    create: (input: CreateNoteInput) =>
      call(true, () => context.notes.create(input)),
    update: (id: string, input: UpdateNoteInput) =>
      call(true, () => context.notes.update(id, input)),
    remove: (id: string) =>
      call(true, () => {
        if (!context.notes.remove(id))
          throw new ApplicationError(404, "Note not found: " + id);
        return true;
      }),
    storageInfo: () =>
      call(false, () => {
        if (!context.notes.storageInfo)
          throw new ApplicationError(503, "便签存储尚未就绪");
        return context.notes.storageInfo();
      }),
  };
}
export type NoteApplicationService = ReturnType<
  typeof createNoteApplicationService
>;

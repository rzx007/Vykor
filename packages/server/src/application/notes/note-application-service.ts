import {
  NoteRevisionConflictError,
  NoteOrganizationConflictError,
  type NoteRepository,
} from "@vykor/services";
import { DomainValidationError as ProtocolValidationError } from "@vykor/domain-contracts/inputs";
import {
  parseSaveNoteOrganizationInput,
  type CreateNoteInput,
  type UpdateNoteInput,
  type NoteOrganizationV1Record,
} from "@vykor/domain-contracts/notes";
import { ApplicationError } from "../../shared/application-error.js";
export interface NoteApplicationContext {
  notes: Pick<NoteRepository, "list" | "create" | "update" | "remove"> &
    Partial<
      Pick<NoteRepository, "storageInfo" | "organization" | "saveOrganization">
    >;
  readiness?(): { phase: string; accepting: boolean };
}
export function createNoteApplicationService(context: NoteApplicationContext) {
  function mapError(error: unknown): never {
    if (error instanceof ApplicationError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new ApplicationError(
      error instanceof ProtocolValidationError
        ? 400
        : error instanceof NoteRevisionConflictError ||
            error instanceof NoteOrganizationConflictError
          ? 409
          : message.includes("Note not found")
            ? 404
            : 500,
      message,
    );
  }
  function call<T>(write: boolean, operation: () => T): T {
    const state = context.readiness?.();
    if (write && state && (state.phase !== "ready" || !state.accepting))
      throw new ApplicationError(
        409,
        "后台尚未就绪或已停止准入，拒绝便签写操作",
      );
    try {
      const result = operation();
      return (result instanceof Promise ? result.catch(mapError) : result) as T;
    } catch (error) {
      return mapError(error);
    }
  }
  return {
    organization: () =>
      call(false, () => {
        if (!context.notes.organization)
          throw new ApplicationError(503, "便签组织存储尚未就绪");
        return context.notes.organization();
      }),
    saveOrganization: (
      organization: NoteOrganizationV1Record,
      expectedEtag: string,
    ) =>
      call(true, () => {
        const input = parseSaveNoteOrganizationInput({
          organization,
          expectedEtag,
        });
        if (!context.notes.saveOrganization)
          throw new ApplicationError(503, "便签组织存储尚未就绪");
        return context.notes.saveOrganization(
          input.organization,
          input.expectedEtag,
        );
      }),
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

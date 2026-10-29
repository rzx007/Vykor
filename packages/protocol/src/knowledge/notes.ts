export {
  MAX_NOTE_CONTENT_LENGTH,
  type NoteRecord,
  type CreateNoteInput,
  type UpdateNoteInput,
} from "@vykor/domain-contracts/notes";
import {
  parseCreateNoteInput as parseCreateDomainNote,
  parseUpdateNoteInput as parseUpdateDomainNote,
  type CreateNoteInput,
  type UpdateNoteInput,
} from "@vykor/domain-contracts/notes";
import { adaptDomainValidation } from "../requests/domain-validation.js";
export type {
  DesktopItem,
  NoteFolderRecord,
  NoteOrganizationV1Record,
  NoteOrganizationSnapshotRecord,
  SaveNoteOrganizationInput,
} from "@vykor/domain-contracts/notes";
export {
  mergeNotes,
  moveNoteToDesktop,
  moveNoteToFolder,
  reorderInContainer,
  dissolveFolder,
  renameFolder,
  validateFolderName,
  reconcileOrganization,
} from "@vykor/domain-contracts/notes";
import {
  parseSaveNoteOrganizationInput as parseDomainSaveOrganization,
  type SaveNoteOrganizationInput,
} from "@vykor/domain-contracts/notes";
export function parseSaveNoteOrganizationInput(
  value: unknown,
): SaveNoteOrganizationInput {
  return adaptDomainValidation(() => parseDomainSaveOrganization(value));
}
export function parseCreateNoteInput(value: unknown): CreateNoteInput {
  return adaptDomainValidation(() => parseCreateDomainNote(value));
}
export function parseUpdateNoteInput(value: unknown): UpdateNoteInput {
  return adaptDomainValidation(() => parseUpdateDomainNote(value));
}

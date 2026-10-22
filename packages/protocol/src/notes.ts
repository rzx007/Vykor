export { MAX_NOTE_CONTENT_LENGTH, type NoteRecord, type CreateNoteInput, type UpdateNoteInput } from "@vykor/domain-contracts/notes";
import { parseCreateNoteInput as parseCreateDomainNote, parseUpdateNoteInput as parseUpdateDomainNote, type CreateNoteInput, type UpdateNoteInput } from "@vykor/domain-contracts/notes";
import { adaptDomainValidation } from "./domain-validation.js";
export function parseCreateNoteInput(value: unknown): CreateNoteInput { return adaptDomainValidation(() => parseCreateDomainNote(value)); }
export function parseUpdateNoteInput(value: unknown): UpdateNoteInput { return adaptDomainValidation(() => parseUpdateDomainNote(value)); }

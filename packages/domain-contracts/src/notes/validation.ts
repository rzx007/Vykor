import { DomainValidationError } from "../validation-error.js";
import { MAX_NOTE_CONTENT_LENGTH, type CreateNoteInput, type UpdateNoteInput } from "./records.js";
export function parseCreateNoteInput(value: unknown): CreateNoteInput {
  const body = readRecord(value);
  rejectUnknownFields(body, ["content"]);
  const content = readContent(body.content);
  if (!content.trim()) {
    throw new DomainValidationError("content must not be blank", "content");
  }
  return { content };
}

export function parseUpdateNoteInput(value: unknown): UpdateNoteInput {
  const body = readRecord(value);
  rejectUnknownFields(body, ["content", "expectedRevision"]);
  const content = readContent(body.content);
  if (
    !Number.isSafeInteger(body.expectedRevision) ||
    Number(body.expectedRevision) < 1
  ) {
    throw new DomainValidationError(
      "expectedRevision must be a positive safe integer",
      "expectedRevision",
    );
  }
  return { content, expectedRevision: Number(body.expectedRevision) };
}

function readRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DomainValidationError("Request body must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function readContent(value: unknown): string {
  if (typeof value !== "string") {
    throw new DomainValidationError("content must be a string", "content");
  }
  if (value.length > MAX_NOTE_CONTENT_LENGTH) {
    throw new DomainValidationError(
      "content is too large",
      "content",
      "payload_too_large",
    );
  }
  return value;
}

function rejectUnknownFields(
  body: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const unknown = Object.keys(body).find((field) => !allowed.includes(field));
  if (unknown) {
    throw new DomainValidationError(
      `Unknown note field: ${unknown}`,
      unknown,
    );
  }
}

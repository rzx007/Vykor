import { ProtocolValidationError } from "./requests.js";

export const MAX_NOTE_CONTENT_LENGTH = 100_000;

export interface NoteRecord {
  id: string;
  content: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface CreateNoteInput {
  content: string;
}

export interface UpdateNoteInput {
  content: string;
  expectedRevision: number;
}

export function parseCreateNoteInput(value: unknown): CreateNoteInput {
  const body = readRecord(value);
  rejectUnknownFields(body, ["content"]);
  const content = readContent(body.content);
  if (!content.trim()) {
    throw new ProtocolValidationError("content must not be blank", "content");
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
    throw new ProtocolValidationError(
      "expectedRevision must be a positive safe integer",
      "expectedRevision",
    );
  }
  return { content, expectedRevision: Number(body.expectedRevision) };
}

function readRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProtocolValidationError("Request body must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function readContent(value: unknown): string {
  if (typeof value !== "string") {
    throw new ProtocolValidationError("content must be a string", "content");
  }
  if (value.length > MAX_NOTE_CONTENT_LENGTH) {
    throw new ProtocolValidationError(
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
    throw new ProtocolValidationError(
      `Unknown note field: ${unknown}`,
      unknown,
    );
  }
}

export type AttachmentErrorCode =
  | "attachment_invalid_request"
  | "attachment_too_large"
  | "attachment_not_found"
  | "attachment_not_ready"
  | "attachment_storage_failed"
  | "attachment_aborted"
  | "prompt_content_required"
  | "attachment_duplicate_reference"
  | "prompt_id_conflict"
  | "attachment_in_use"
  | "attachment_structured_steer_unsupported"
  | "attachment_count_exceeded"
  | "attachment_prompt_size_exceeded"
  | "attachment_session_size_exceeded";

export class AttachmentError extends Error {
  readonly name = "AttachmentError";

  constructor(
    readonly code: AttachmentErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(`${code}: ${message}`);
  }
}

export function isAttachmentError(error: unknown): error is AttachmentError {
  return error instanceof AttachmentError;
}

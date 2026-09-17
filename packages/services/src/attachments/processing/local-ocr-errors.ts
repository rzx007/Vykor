export type LocalOcrErrorCode =
  | "ocr_cancelled"
  | "ocr_invalid_image"
  | "ocr_resource_limit_exceeded"
  | "ocr_package_load_failed"
  | "ocr_inference_failed"
  | "ocr_queue_full"
  | "ocr_service_closed";

export class LocalOcrError extends Error {
  constructor(readonly code: LocalOcrErrorCode, message: string, readonly retryable = false) {
    super(message);
    this.name = "LocalOcrError";
  }
}

export function normalizeLocalOcrError(error: unknown): LocalOcrError {
  if (error instanceof LocalOcrError) return error;
  if (isAbort(error)) return new LocalOcrError("ocr_cancelled", "OCR was cancelled");
  const code = typeof error === "object" && error && "code" in error
    ? String((error as { code: unknown }).code)
    : "";
  if (code === "invalid_image" || code === "invalid_argument") {
    return new LocalOcrError("ocr_invalid_image", "The attachment is not a valid OCR image");
  }
  if (code === "resource_limit_exceeded") {
    return new LocalOcrError("ocr_resource_limit_exceeded", "The image exceeds OCR resource limits");
  }
  if (code === "package_load_failed" || code === "unsupported_platform") {
    return new LocalOcrError("ocr_package_load_failed", "The local OCR runtime could not be loaded");
  }
  if (code === "queue_full") {
    return new LocalOcrError("ocr_queue_full", "The local OCR queue is full", true);
  }
  return new LocalOcrError(
    "ocr_inference_failed",
    error instanceof Error ? error.message : "Local OCR inference failed",
    true,
  );
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError"
    || error instanceof Error && /abort|cancel|stop/i.test(error.message);
}


import { AttachmentError } from "../attachment-errors.js";

const MAX_FILENAME_CODE_POINTS = 255;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;

export function decodeAttachmentFilename(encoded: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(encoded);
  } catch {
    throw invalidFilename("filename is not valid URI-encoded UTF-8");
  }
  const leaf = decoded.split(/[\\/]/).at(-1) ?? "";
  const normalized = leaf.normalize("NFC").replace(CONTROL_CHARACTERS, "").trim();
  if (normalized.length === 0 || normalized === "." || normalized === "..") {
    throw invalidFilename("filename is empty after normalization");
  }
  if (Array.from(normalized).length > MAX_FILENAME_CODE_POINTS) {
    throw invalidFilename(
      `filename exceeds ${MAX_FILENAME_CODE_POINTS} Unicode code points`,
    );
  }
  return normalized;
}

function invalidFilename(message: string): AttachmentError {
  return new AttachmentError("attachment_invalid_request", message);
}

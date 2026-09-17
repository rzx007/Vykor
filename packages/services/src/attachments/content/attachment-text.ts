export type AttachmentCandidateKind =
  | "image"
  | "text"
  | "document"
  | "archive"
  | "binary";

export type AttachmentTextEncoding = "utf-8" | "utf-16le" | "utf-16be";

export interface AttachmentCandidateInput {
  displayName: string;
  mediaType?: string;
}

export interface DecodedAttachmentText {
  text: string;
  encoding: AttachmentTextEncoding;
}

export class AttachmentTextDecodingError extends Error {
  readonly name = "AttachmentTextDecodingError";

  constructor(
    readonly kind: "unsupported_encoding" | "invalid_text",
    message: string,
  ) {
    super(message);
  }
}

const DOCUMENT_EXTENSIONS = new Set([
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".odt", ".ods", ".odp",
]);
const ARCHIVE_EXTENSIONS = new Set([
  ".zip", ".rar", ".7z", ".tar", ".gz", ".gzip", ".tgz", ".bz2", ".xz",
]);
const TEXT_EXTENSIONS = new Set([
  ".txt", ".text", ".md", ".mdx", ".rst", ".log", ".csv", ".tsv",
  ".json", ".jsonl", ".ndjson", ".xml", ".yaml", ".yml", ".toml",
  ".ini", ".cfg", ".conf", ".properties", ".env",
  ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts",
  ".css", ".scss", ".sass", ".less", ".html", ".htm", ".vue", ".svelte",
  ".py", ".pyi", ".rb", ".php", ".java", ".kt", ".kts", ".scala",
  ".go", ".rs", ".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".cs",
  ".swift", ".dart", ".lua", ".pl", ".pm", ".r", ".sql", ".graphql",
  ".sh", ".bash", ".zsh", ".fish", ".ps1", ".bat", ".cmd",
  ".dockerfile", ".makefile", ".gradle", ".cmake",
]);
const DOCUMENT_MEDIA_TYPES = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.oasis.opendocument.spreadsheet",
  "application/vnd.oasis.opendocument.presentation",
]);
const ARCHIVE_MEDIA_TYPES = new Set([
  "application/zip", "application/x-zip-compressed", "application/x-rar-compressed",
  "application/vnd.rar", "application/x-7z-compressed", "application/x-tar",
  "application/gzip", "application/x-gzip", "application/x-bzip2", "application/x-xz",
]);
const TEXT_MEDIA_TYPES = new Set([
  "application/json", "application/ld+json", "application/x-ndjson",
  "application/xml", "application/yaml", "application/x-yaml", "application/toml",
  "application/javascript", "application/typescript", "application/sql",
  "application/graphql",
]);

export function classifyAttachmentCandidate(
  input: AttachmentCandidateInput,
): AttachmentCandidateKind {
  const mediaType = (input.mediaType ?? "").split(";", 1)[0]!.trim().toLowerCase();
  const extension = attachmentExtension(input.displayName);

  // The media type comes from server-side sniffing. A recognized binary type
  // must win over a misleading filename.
  if (mediaType.startsWith("image/")) return "image";
  if (DOCUMENT_MEDIA_TYPES.has(mediaType)) return "document";
  if (DOCUMENT_EXTENSIONS.has(extension)) return "document";
  if (ARCHIVE_MEDIA_TYPES.has(mediaType)) {
    return DOCUMENT_EXTENSIONS.has(extension) ? "document" : "archive";
  }
  if (ARCHIVE_EXTENSIONS.has(extension)) return "archive";
  if (mediaType.startsWith("text/") || TEXT_MEDIA_TYPES.has(mediaType)) return "text";
  if (TEXT_EXTENSIONS.has(extension) || isConventionalTextFilename(input.displayName)) {
    return "text";
  }
  return "binary";
}

export function decodeAttachmentText(bytes: Uint8Array): DecodedAttachmentText {
  let encoding: AttachmentTextEncoding = "utf-8";
  let body = bytes;
  if (hasPrefix(bytes, [0xef, 0xbb, 0xbf])) {
    body = bytes.subarray(3);
  } else if (hasPrefix(bytes, [0xff, 0xfe])) {
    encoding = "utf-16le";
    body = bytes.subarray(2);
  } else if (hasPrefix(bytes, [0xfe, 0xff])) {
    encoding = "utf-16be";
    body = bytes.subarray(2);
  } else if (looksLikeBomlessUtf16(bytes)) {
    throw new AttachmentTextDecodingError(
      "unsupported_encoding",
      "UTF-16 attachment text requires a byte-order mark",
    );
  }

  let text: string;
  try {
    if (encoding !== "utf-8" && body.byteLength % 2 !== 0) {
      throw new TypeError("incomplete UTF-16 code unit");
    }
    const decoderBytes = encoding === "utf-16be" ? swapUtf16ByteOrder(body) : body;
    text = new TextDecoder(encoding === "utf-8" ? "utf-8" : "utf-16", {
      fatal: true,
    }).decode(decoderBytes);
  } catch {
    throw new AttachmentTextDecodingError(
      "unsupported_encoding",
      `attachment is not valid ${encoding}`,
    );
  }
  if (/\u0000/u.test(text)) {
    throw new AttachmentTextDecodingError("invalid_text", "attachment text contains NUL bytes");
  }
  if (/[\u0001-\u0008\u000B\u000E-\u001F\u007F]/u.test(text)) {
    throw new AttachmentTextDecodingError(
      "invalid_text",
      "attachment text contains binary control characters",
    );
  }
  return { text: text.replace(/\r\n?/gu, "\n"), encoding };
}

function swapUtf16ByteOrder(bytes: Uint8Array): Uint8Array {
  const swapped = new Uint8Array(bytes.byteLength);
  for (let index = 0; index < bytes.byteLength; index += 2) {
    swapped[index] = bytes[index + 1]!;
    swapped[index + 1] = bytes[index]!;
  }
  return swapped;
}

function attachmentExtension(displayName: string): string {
  const normalized = displayName.trim().toLowerCase();
  if (normalized.endsWith(".tar.gz")) return ".tar";
  const lastSlash = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  const lastDot = normalized.lastIndexOf(".");
  return lastDot > lastSlash ? normalized.slice(lastDot) : "";
}

function isConventionalTextFilename(displayName: string): boolean {
  const name = displayName.trim().toLowerCase().replaceAll("\\", "/").split("/").at(-1);
  return name === "dockerfile" || name === "makefile" || name === "cmakelists.txt" ||
    name === "license" || name === "readme" || name === ".gitignore";
}

function hasPrefix(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((value, index) => bytes[index] === value);
}

function looksLikeBomlessUtf16(bytes: Uint8Array): boolean {
  if (bytes.length < 2) return false;
  const sampleLength = Math.min(bytes.length, 64);
  let evenNuls = 0;
  let oddNuls = 0;
  for (let index = 0; index < sampleLength; index += 1) {
    if (bytes[index] !== 0) continue;
    if (index % 2 === 0) evenNuls += 1;
    else oddNuls += 1;
  }
  return evenNuls >= 1 || oddNuls >= 1;
}

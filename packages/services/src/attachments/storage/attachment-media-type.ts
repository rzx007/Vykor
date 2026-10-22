import { OFFICE_MEDIA_TYPES, type OfficeFormat } from "@vykor/protocol";
const OCTET_STREAM = "application/octet-stream";

const SIGNATURES: ReadonlyArray<{
  mediaType: string;
  matches(bytes: Uint8Array): boolean;
}> = [
  {
    mediaType: "image/png",
    matches: (bytes) =>
      startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  },
  {
    mediaType: "image/jpeg",
    matches: (bytes) => startsWith(bytes, [0xff, 0xd8, 0xff]),
  },
  {
    mediaType: "image/bmp",
    matches: (bytes) => startsWith(bytes, [0x42, 0x4d]),
  },
  {
    mediaType: "image/gif",
    matches: (bytes) =>
      startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
      startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]),
  },
  {
    mediaType: "image/webp",
    matches: (bytes) =>
      startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
      matchesAt(bytes, 8, [0x57, 0x45, 0x42, 0x50]),
  },
  {
    mediaType: "application/pdf",
    matches: (bytes) => startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d]),
  },
  {
    mediaType: "application/zip",
    matches: (bytes) =>
      startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) ||
      startsWith(bytes, [0x50, 0x4b, 0x05, 0x06]) ||
      startsWith(bytes, [0x50, 0x4b, 0x07, 0x08]),
  },
];

export function sniffAttachmentMediaType(
  prefix: Uint8Array,
  declaredMediaType?: string,
  prefixIsComplete = true,
): string {
  for (const signature of SIGNATURES) {
    if (signature.matches(prefix)) return signature.mediaType;
  }
  if (prefix.length === 0 || prefix.includes(0)) return OCTET_STREAM;

  const declared = normalizeDeclaredTextMediaType(declaredMediaType);
  if (!declared) return OCTET_STREAM;
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    decoder.decode(prefix, { stream: !prefixIsComplete });
    return declared;
  } catch {
    return OCTET_STREAM;
  }
}

function normalizeDeclaredTextMediaType(value?: string): string | undefined {
  if (!value) return undefined;
  const base = value.split(";", 1)[0]?.trim().toLowerCase();
  if (!base?.startsWith("text/")) return undefined;
  return /^text\/[a-z0-9!#$&^_.+-]+$/.test(base) ? base : undefined;
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  return matchesAt(bytes, 0, signature);
}

function matchesAt(
  bytes: Uint8Array,
  offset: number,
  signature: readonly number[],
): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((value, index) => bytes[offset + index] === value);
}


/** Inspect the ZIP directory without extracting data or trusting a declared MIME type. */
export function sniffOfficePackage(input: Uint8Array): string | undefined {
  const b = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  let end = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) {
    if (
      b.readUInt32LE(i) === 0x06054b50 &&
      i + 22 + b.readUInt16LE(i + 20) === b.length
    ) {
      end = i;
      break;
    }
  }
  if (end < 0) return undefined;
  const count = b.readUInt16LE(end + 10),
    size = b.readUInt32LE(end + 12),
    start = b.readUInt32LE(end + 16);
  if (count === 65535 || count > 10000 || start + size > end) return undefined;
  const names = new Set<string>();
  let p = start,
    total = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > b.length || b.readUInt32LE(p) !== 0x02014b50) return undefined;
    const flags = b.readUInt16LE(p + 8),
      method = b.readUInt16LE(p + 10);
    const n = b.readUInt16LE(p + 28),
      extra = b.readUInt16LE(p + 30),
      comment = b.readUInt16LE(p + 32);
    if (
      p + 46 + n + extra + comment > start + size ||
      flags & 1 ||
      ![0, 8].includes(method)
    )
      return undefined;
    total += b.readUInt32LE(p + 24);
    if (total > 256 * 1024 * 1024) return undefined;
    const name = b.subarray(p + 46, p + 46 + n).toString("utf8");
    if (
      name.includes("\\") ||
      name.startsWith("/") ||
      name.split("/").includes("..") ||
      /vbaProject\.bin$/i.test(name) ||
      names.has(name)
    )
      return undefined;
    names.add(name);
    p += 46 + n + extra + comment;
  }
  if (!names.has("[Content_Types].xml")) return undefined;
  const matches = (
    [
      ["docx", "word/document.xml"],
      ["xlsx", "xl/workbook.xml"],
      ["pptx", "ppt/presentation.xml"],
    ] as const
  ).filter(([, part]) => names.has(part));
  return matches.length === 1
    ? OFFICE_MEDIA_TYPES[matches[0]![0] as OfficeFormat]
    : undefined;
}

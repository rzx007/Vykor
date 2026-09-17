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

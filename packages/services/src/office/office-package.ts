import { OFFICE_MEDIA_TYPES, type OfficeFormat } from "@vykor/protocol";

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

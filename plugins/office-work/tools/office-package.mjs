import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
// Bounded read-only Office package inspection. Never rewrites XML or ZIP entries.
export function readOfficeParts(bytes, requiredPart) {
  const fail = () => {
    throw new Error("Office 文件包不受支持或已损坏。");
  };
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--)
    if (
      bytes.readUInt32LE(i) === 0x06054b50 &&
      i + 22 + bytes.readUInt16LE(i + 20) === bytes.length
    ) {
      end = i;
      break;
    }
  if (end < 0) fail();
  const count = bytes.readUInt16LE(end + 10),
    start = bytes.readUInt32LE(end + 16),
    size = bytes.readUInt32LE(end + 12);
  if (
    count > 10000 ||
    bytes.readUInt16LE(end + 4) ||
    bytes.readUInt16LE(end + 6) ||
    bytes.readUInt16LE(end + 8) !== count ||
    start + size !== end
  )
    fail();
  let at = start,
    total = 0;
  const out = new Map();
  out.rawHashes = new Map();
  for (let i = 0; i < count; i++) {
    if (at + 46 > end || bytes.readUInt32LE(at) !== 0x02014b50) fail();
    const flags = bytes.readUInt16LE(at + 8),
      method = bytes.readUInt16LE(at + 10),
      length = bytes.readUInt32LE(at + 20),
      raw = bytes.readUInt32LE(at + 24),
      nameLength = bytes.readUInt16LE(at + 28),
      next =
        at +
        46 +
        nameLength +
        bytes.readUInt16LE(at + 30) +
        bytes.readUInt16LE(at + 32),
      local = bytes.readUInt32LE(at + 42);
    if (
      next > end ||
      flags & 1 ||
      ![0, 8].includes(method) ||
      (total += raw) > 64000000 ||
      local + 30 > start ||
      bytes.readUInt32LE(local) !== 0x04034b50
    )
      fail();
    const name = bytes.toString("utf8", at + 46, at + 46 + nameLength);
    if (
      out.has(name) ||
      name.includes("..") ||
      name.includes("\\") ||
      name.startsWith("/")
    )
      fail();
    const p =
      local +
      30 +
      bytes.readUInt16LE(local + 26) +
      bytes.readUInt16LE(local + 28);
    if (p + length > start) fail();
    const packed = bytes.subarray(p, p + length),
      data =
        method === 0
          ? packed
          : inflateRawSync(packed, { maxOutputLength: Math.max(1, raw) });
    if (data.length !== raw) fail();
    out.set(name, data.toString("utf8"));
    out.rawHashes.set(name, createHash("sha256").update(data).digest("hex"));
    at = next;
  }
  if (at !== end || !out.has(requiredPart)) fail();
  return out;
}

import { crc32, inflateRawSync } from 'node:zlib';

// Release archives contain six native binaries. Inspect their directory sizes,
// but expand only the small text files needed by official-skill verification.
// Office document inspection retains its separate 64 MB limit.
export function readReleaseTextParts(bytes, requiredPaths) {
  const fail = () => { throw Error('Invalid plugin release archive'); };
  if (bytes.length > 100 * 1024 * 1024) fail();
  let end = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 65557); at--) {
    if (bytes.readUInt32LE(at) === 0x06054b50 && at + 22 + bytes.readUInt16LE(at + 20) === bytes.length) { end = at; break; }
  }
  if (end < 0) fail();
  const count = bytes.readUInt16LE(end + 10), start = bytes.readUInt32LE(end + 16);
  if (count > 10000 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6) || bytes.readUInt16LE(end + 8) !== count || start + bytes.readUInt32LE(end + 12) !== end) fail();
  const wanted = new Set(requiredPaths), seen = new Set(), parts = new Map(), roots = new Set();
  let at = start, total = 0;
  for (let index = 0; index < count; index++) {
    if (at + 46 > end || bytes.readUInt32LE(at) !== 0x02014b50) fail();
    const flags = bytes.readUInt16LE(at + 8), method = bytes.readUInt16LE(at + 10), length = bytes.readUInt32LE(at + 20), raw = bytes.readUInt32LE(at + 24);
    const nameLength = bytes.readUInt16LE(at + 28), next = at + 46 + nameLength + bytes.readUInt16LE(at + 30) + bytes.readUInt16LE(at + 32), local = bytes.readUInt32LE(at + 42);
    if (next > end || flags & 1 || ![0, 8].includes(method) || (total += raw) > 250 * 1024 * 1024 || local + 30 > start || bytes.readUInt32LE(local) !== 0x04034b50) fail();
    const name = bytes.toString('utf8', at + 46, at + 46 + nameLength);
    if (seen.has(name) || name.includes('..') || name.includes('\\') || name.startsWith('/')) fail();
    seen.add(name);
    const localNameLength = bytes.readUInt16LE(local + 26), dataStart = local + 30 + localNameLength + bytes.readUInt16LE(local + 28);
    if (dataStart + length > start || bytes.toString('utf8', local + 30, local + 30 + localNameLength) !== name || bytes.readUInt16LE(local + 6) !== flags || bytes.readUInt16LE(local + 8) !== method) fail();
    const slash = name.indexOf('/');
    const key = wanted.has(name) ? name : slash >= 0 && wanted.has(name.slice(slash + 1)) ? name.slice(slash + 1) : undefined;
    if (key !== undefined) {
      roots.add(name.slice(0, name.length - key.length));
      if (roots.size > 1 || parts.has(key)) fail();
      if (raw > 4 * 1024 * 1024) fail();
      const packed = bytes.subarray(dataStart, dataStart + length);
      const data = method === 0 ? packed : inflateRawSync(packed, { maxOutputLength: Math.max(1, raw) });
      if (data.length !== raw || crc32(data) !== bytes.readUInt32LE(at + 16)) fail();
      parts.set(key, data);
    }
    at = next;
  }
  if (at !== end) fail();
  return parts;
}

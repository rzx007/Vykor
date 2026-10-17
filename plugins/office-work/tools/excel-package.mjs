import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
// Bounded read-only XLSX package inspection. Never rewrites XML or ZIP entries.
export function workbookParts(bytes) {
  const fail = () => {
    throw new Error("工作簿文件包不受支持或已损坏。");
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
  if (at !== end || !out.has("xl/workbook.xml")) fail();
  return out;
}
const unescape = (s) =>
  s.replace(/&#(x[0-9a-f]+|\d+);|&(amp|lt|gt|quot|apos);/gi, (_, num, key) =>
    num
      ? String.fromCodePoint(
          num[0].toLowerCase() === "x"
            ? parseInt(num.slice(1), 16)
            : Number(num),
        )
      : { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[key],
  );
const attrs = (s) =>
  Object.fromEntries(
    [...s.matchAll(/([\w:.-]+)\s*=\s*(["'])(.*?)\2/gs)].map((m) => [
      m[1],
      unescape(m[3]),
    ]),
  );
export function verifyWrittenCells(parts, operations) {
  const workbook = parts.get("xl/workbook.xml"),
    rels = parts.get("xl/_rels/workbook.xml.rels") ?? "",
    targets = new Map(
      [...rels.matchAll(/<(?:\w+:)?Relationship\b([^>]*)\/?\s*>/g)].map((m) => {
        const a = attrs(m[1]);
        return [a.Id, a.Target?.replace(/^\/?xl\//, "")];
      }),
    );
  const sheets = new Map(
    [...workbook.matchAll(/<(?:\w+:)?sheet\b([^>]*)\/?\s*>/g)].map((m) => {
      const a = attrs(m[1]);
      return [a.name, parts.get("xl/" + targets.get(a["r:id"]))];
    }),
  );
  const strings = [
    ...(parts.get("xl/sharedStrings.xml") ?? "").matchAll(
      /<(?:\w+:)?si\b[^>]*>([\s\S]*?)<\/(?:\w+:)?si>/g,
    ),
  ].map((m) =>
    [...m[1].matchAll(/<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/g)]
      .map((t) => unescape(t[1]))
      .join(""),
  );
  for (const op of operations.filter(
    (o) => o.command === "set" && /^\/[^/]+\/[A-Z]+\d+$/.test(o.path),
  )) {
    const [, sheet, address] = op.path.split("/"),
      xml = sheets.get(sheet);
    if (!xml) throw new Error("写入后工作表丢失。");
    const cells = [
      ...xml.matchAll(
        /<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g,
      ),
    ];
    const found = cells.find((m) => attrs(m[1]).r === address),
      a = found ? attrs(found[1]) : {},
      body = found?.[2] ?? "",
      v = unescape(
        body.match(/<(?:\w+:)?v\b[^>]*>([\s\S]*?)<\/(?:\w+:)?v>/)?.[1] ?? "",
      ),
      formula = unescape(
        body.match(/<(?:\w+:)?f\b[^>]*>([\s\S]*?)<\/(?:\w+:)?f>/)?.[1] ?? "",
      );
    if (op.props.formula !== undefined) {
      if (formula !== op.props.formula)
        throw new Error(`公式写入核对失败：${op.path}`);
    } else if (op.props.value !== undefined) {
      const actual =
        a.t === "s"
          ? strings[Number(v)]
          : a.t === "inlineStr"
            ? [...body.matchAll(/<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/g)]
                .map((m) => unescape(m[1]))
                .join("")
            : v;
      const matches =
        op.props.type === "number"
          ? actual !== "" && Number(actual) === Number(op.props.value)
          : actual === op.props.value &&
            (["s", "inlineStr", "str"].includes(a.t) || actual === "");
      if (formula || !matches)
        throw new Error(`数值或文本类型写入核对失败：${op.path}`);
    }
  }
  return { written_cells_verified: true };
}

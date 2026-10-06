import type { AutoReviewChangeFile } from "./auto-review-policy.js";
import type { GitDirtyEntry } from "./git-run-change-inspector.js";

export const GIT_PATCH_LIMIT_BYTES = 512 * 1024;

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
export interface StatusEntry {
  path: string;
  oldPath?: string;
  status: string;
}

export interface RepoState {
  root: string;
  head: string;
  statusRaw: Buffer;
  entries: StatusEntry[];
  statusByPath: Map<string, string>;
  index: Map<string, { hash: string; mode: string }>;
}

export function buildDigest(
  state: RepoState,
  paths: string[],
  hashes: Record<string, string | "missing">,
): string {
  const sorted = uniquePaths(paths).sort();
  const parts = [state.root, state.head, state.statusRaw.toString("base64")];
  for (const path of sorted) {
    const indexEntry = state.index.get(path);
    parts.push(
      `${path}\u0001${indexEntry ? `${indexEntry.mode} ${indexEntry.hash}` : "missing"}\u0001${
        hashes[path] ?? "missing"
      }`,
    );
  }
  return parts.join("\u0002");
}

export function parseStatus(buffer: Buffer): StatusEntry[] | undefined {
  const records = splitNul(buffer);
  const entries: StatusEntry[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (record.length < 4 || record[2] !== 0x20) return undefined;
    const status = record.subarray(0, 2).toString("latin1");
    const path = decodeField(record.subarray(3));
    if (path === undefined) return undefined;
    const entry: StatusEntry = { path, status };
    if (status[0] === "R" || status[0] === "C") {
      const oldRecord = records[index + 1];
      if (oldRecord === undefined) return undefined;
      const oldPath = decodeField(oldRecord);
      if (oldPath === undefined) return undefined;
      entry.oldPath = oldPath;
      index += 1;
    }
    entries.push(entry);
  }
  return entries;
}

export function parseIndex(buffer: Buffer): Map<string, { hash: string; mode: string }> | undefined {
  const records = splitNul(buffer);
  const map = new Map<string, { hash: string; mode: string }>();
  for (const record of records) {
    const tab = record.indexOf(0x09);
    if (tab < 0) return undefined;
    const meta = record.subarray(0, tab).toString("latin1").split(" ");
    const mode = meta[0] ?? "";
    const hash = meta[1] ?? "";
    const path = decodeField(record.subarray(tab + 1));
    if (path === undefined || mode.length === 0 || hash.length === 0) return undefined;
    map.set(path, { hash, mode });
  }
  return map;
}

export function parseNameStatus(
  buffer: Buffer,
): Map<string, { code: string; oldPath?: string }> | undefined {
  const records = splitNul(buffer);
  const map = new Map<string, { code: string; oldPath?: string }>();
  for (let index = 0; index < records.length; index += 1) {
    const code = records[index]!.toString("latin1");
    if (code.length === 0) return undefined;
    const first = records[index + 1];
    if (first === undefined) return undefined;
    const firstPath = decodeField(first);
    if (firstPath === undefined) return undefined;
    if (code[0] === "R" || code[0] === "C") {
      const second = records[index + 2];
      if (second === undefined) return undefined;
      const newPath = decodeField(second);
      if (newPath === undefined) return undefined;
      map.set(newPath, { code, oldPath: firstPath });
      index += 2;
    } else {
      map.set(firstPath, { code });
      index += 1;
    }
  }
  return map;
}

export function parseNumstat(buffer: Buffer): Map<string, number> | undefined {
  const records = splitNul(buffer);
  const map = new Map<string, number>();
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    const parts = record.toString("latin1").split("\t");
    if (parts.length < 3) return undefined;
    const added = parts[0]!;
    const deleted = parts[1]!;
    const inlinePath = parts.slice(2).join("\t");
    const lineCount = (isBinaryCount(added) ? 0 : Number(added)) + (isBinaryCount(deleted) ? 0 : Number(deleted));
    if (inlinePath.length > 0) {
      const path = decodeField(Buffer.from(inlinePath, "latin1"));
      if (path === undefined) return undefined;
      map.set(path, lineCount);
    } else {
      const oldPath = records[index + 1];
      const newPath = records[index + 2];
      if (oldPath === undefined || newPath === undefined) return undefined;
      const decoded = decodeField(newPath);
      if (decoded === undefined) return undefined;
      map.set(decoded, lineCount);
      index += 2;
    }
  }
  return map;
}

export function assemblePatch(chunks: Array<{ path: string; text: string }>): {
  patch: string;
  truncated: boolean;
} {
  const sorted = [...chunks].sort((left, right) => left.path.localeCompare(right.path));
  const parts: Buffer[] = [];
  let size = 0;
  let truncated = false;
  for (const chunk of sorted) {
    const buffer = Buffer.from(chunk.text, "utf8");
    const remaining = GIT_PATCH_LIMIT_BYTES - size;
    if (buffer.length <= remaining) {
      parts.push(buffer);
      size += buffer.length;
      continue;
    }
    if (remaining > 0) parts.push(buffer.subarray(0, remaining));
    size = GIT_PATCH_LIMIT_BYTES;
    truncated = true;
    break;
  }
  return { patch: Buffer.concat(parts).toString("utf8"), truncated };
}

export function sortFiles(files: AutoReviewChangeFile[]): AutoReviewChangeFile[] {
  return [...files].sort((left, right) => left.path.localeCompare(right.path));
}

export function sameDirtyMap(
  left: Record<string, GitDirtyEntry>,
  right: Record<string, GitDirtyEntry>,
): boolean {
  return serializeDirty(left) === serializeDirty(right);
}

function serializeDirty(dirty: Record<string, GitDirtyEntry>): string {
  return Object.keys(dirty)
    .sort()
    .map((path) => {
      const entry = dirty[path]!;
      return `${path}\u0001${entry.status}\u0001${entry.worktreeHash}\u0001${entry.indexHash}\u0001${entry.indexMode}`;
    })
    .join("\u0002");
}

export function mapStatus(code: string): AutoReviewChangeFile["status"] {
  switch (code[0]) {
    case "A":
      return "added";
    case "M":
    case "T":
      return "modified";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    default:
      return "unknown";
  }
}

export function isUnmergedStatus(status: string): boolean {
  return status.includes("U") || status === "DD" || status === "AA";
}

function isBinaryCount(value: string): boolean {
  return value === "-";
}

function splitNul(buffer: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] === 0) {
      parts.push(buffer.subarray(start, index));
      start = index + 1;
    }
  }
  if (start < buffer.length) parts.push(buffer.subarray(start));
  return parts;
}

function decodeField(buffer: Buffer): string | undefined {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    if (CONTROL_CHARACTER_PATTERN.test(text)) return undefined;
    return text;
  } catch {
    return undefined;
  }
}

export function decodeTrimmed(buffer: Buffer): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer).trim();
  } catch {
    return undefined;
  }
}

export function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths)];
}

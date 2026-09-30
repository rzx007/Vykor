import { createHash } from "node:crypto";

/** Canonical memory taxonomy, mirroring Python `schema.MemoryType`. */
export type MemoryType = "user" | "feedback" | "project" | "reference";
/** Canonical scope taxonomy, mirroring Python `schema.MemoryScope`. */
export type MemoryScope = "private" | "project" | "team";

export const MEMORY_TYPES: readonly MemoryType[] = [
  "user",
  "feedback",
  "project",
  "reference",
];
export const MEMORY_SCOPES: readonly MemoryScope[] = [
  "private",
  "project",
  "team",
];

export const DEFAULT_MEMORY_TYPE: MemoryType = "project";
export const DEFAULT_MEMORY_SCOPE: MemoryScope = "project";

export const SCHEMA_VERSION = 1;

/** Stable frontmatter field order (subset of Python `FRONTMATTER_FIELDS`). */
export const FRONTMATTER_FIELDS = [
  "schema_version",
  "id",
  "name",
  "description",
  "type",
  "scope",
  "importance",
  "signature",
  "created_at",
  "updated_at",
  "use_count",
  "last_used_at",
  "tags",
] as const;

// Entrypoint (MEMORY.md) truncation limits, mirroring Python.
export const MAX_ENTRYPOINT_LINES = 200;
export const MAX_ENTRYPOINT_BYTES = 25_000;

/**
 * A single in-memory representation of one Markdown memory record.
 */
export interface MemoryEntry {
  id: string;
  content: string;
  tags?: string[];
  createdAt: number;
  updatedAt: number;
  metadata?: Record<string, unknown>;
  // Structured frontmatter fields (aligned with Python schema v1):
  name?: string;
  description?: string;
  type?: MemoryType;
  scope?: MemoryScope;
  importance?: number;
  signature?: string;
  useCount?: number;
  lastUsedAt?: number;
}

export interface MemorySearchResult {
  entry: MemoryEntry;
  score: number;
}

export interface MemorySearchOptions {
  query: string;
  tags?: string[];
  limit?: number;
}

/** Optional structured fields accepted by {@link MemoryManager.add}. */
export interface MemoryAddOptions {
  name?: string;
  description?: string;
  type?: MemoryType;
  scope?: MemoryScope;
  importance?: number;
}

const ASCII_TOKEN_RE = /[a-z0-9_]+/g;
const HAN_CHAR_RE = /[一-鿿㐀-䶿]/g;

// ──────────────────────────────────────────────────────────────────────────
// Tokenizer (A.4 — keep as-is)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Extract search tokens from {@link text}, handling ASCII words and Han
 * ideographs. Mirrors the Python `_tokenize` heuristic:
 * - ASCII word tokens (letters/digits/underscore) of length >= 3
 * - each CJK ideograph as its own token (each character carries meaning)
 *
 * Returns a de-duplicated list so each distinct token is scored once per
 * occurrence in the target text.
 */
export function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  const tokens = new Set<string>();

  for (const match of lower.matchAll(ASCII_TOKEN_RE)) {
    if (match[0].length >= 3) {
      tokens.add(match[0]);
    }
  }
  // Match Han chars against the original text (case-folding is a no-op for CJK).
  for (const match of text.matchAll(HAN_CHAR_RE)) {
    tokens.add(match[0]);
  }

  return [...tokens];
}

// ──────────────────────────────────────────────────────────────────────────
// Content signature (dedup) — mirrors Python schema.py
// ──────────────────────────────────────────────────────────────────────────

const PUNCTUATION_RE = /[!-/:-@[-`{-~]/g;

/** Normalize memory content for deterministic signatures. */
export function normalizeMemoryContent(text: string): string {
  const lowered = text.toLowerCase();
  const collapsed = lowered.replace(/\s+/g, " ");
  return collapsed.replace(PUNCTUATION_RE, "").trim();
}

/** Compute a deterministic sha256 content signature for duplicate detection. */
export function computeMemorySignature(
  content: string,
  type: string,
  category: string,
): string {
  const normalized = normalizeMemoryContent(content);
  const payload = `${normalized}|${type.trim().toLowerCase()}|${category
    .trim()
    .toLowerCase()}`;
  return createHash("sha256").update(payload, "utf-8").digest("hex");
}

// ──────────────────────────────────────────────────────────────────────────
// Frontmatter parse / render — mirrors Python schema.py
// ──────────────────────────────────────────────────────────────────────────

/**
 * Split a memory file into frontmatter metadata and body text.
 * Returns `{ metadata, body, hasClosedFrontmatter }`. Unclosed frontmatter is
 * treated as body content after the opening delimiter.
 */
export function splitMemoryFile(content: string): {
  metadata: Record<string, unknown>;
  body: string;
  hasClosedFrontmatter: boolean;
} {
  const lines = content.split(/(?<=\n)/); // keep line endings
  if (lines.length === 0 || lines[0]!.trim() !== "---") {
    return { metadata: {}, body: content, hasClosedFrontmatter: false };
  }

  for (let idx = 1; idx < lines.length; idx++) {
    if (lines[idx]!.trim() === "---") {
      const rawFrontmatter = lines.slice(1, idx).join("");
      const metadata = parseFrontmatter(rawFrontmatter);
      const body = lines.slice(idx + 1).join("");
      return { metadata, body, hasClosedFrontmatter: true };
    }
  }

  return { metadata: {}, body: lines.slice(1).join(""), hasClosedFrontmatter: false };
}

/**
 * Parse frontmatter text into a metadata object. This is a small subset of
 * YAML matching how the Python renderer emits values: `key: <json-value>`
 * one per line, where values are JSON scalars/arrays (the Python renderer uses
 * `json.dumps`), plus tolerance for plain unquoted scalars and `[a, b]` lists.
 */
export function parseFrontmatter(raw: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const rawValue = line.slice(colon + 1).trim();
    if (!key) continue;
    result[key] = parseScalar(rawValue);
  }
  return result;
}

function parseScalar(raw: string): unknown {
  if (raw === "" || raw === "null" || raw === "~") return null;
  if (raw === "true") return true;
  if (raw === "false") return false;
  // JSON-encoded value (string / array / number) from the renderer.
  if (
    raw.startsWith('"') ||
    raw.startsWith("[") ||
    raw.startsWith("{")
  ) {
    try {
      return JSON.parse(raw);
    } catch {
      // fall through to plain handling
    }
  }
  if (/^-?\d+$/.test(raw)) return Number.parseInt(raw, 10);
  if (/^-?\d*\.\d+$/.test(raw)) return Number.parseFloat(raw);
  return raw;
}

/** Render memory frontmatter in the stable field order. */
export function renderFrontmatter(metadata: Record<string, unknown>): string {
  const ordered: Array<[string, unknown]> = [];
  const fieldSet = new Set<string>(FRONTMATTER_FIELDS);
  for (const field of FRONTMATTER_FIELDS) {
    if (field in metadata) ordered.push([field, metadata[field]]);
  }
  for (const [key, value] of Object.entries(metadata)) {
    if (!fieldSet.has(key)) ordered.push([key, value]);
  }
  return ordered
    .map(([key, value]) => `${key}: ${formatYamlValue(value)}\n`)
    .join("");
}

function formatYamlValue(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number" && Number.isInteger(value)) return String(value);
  if (Array.isArray(value)) return JSON.stringify(value);
  return JSON.stringify(String(value));
}

/** Render metadata and body as a memory markdown file. */
export function renderMemoryFile(
  metadata: Record<string, unknown>,
  body: string,
): string {
  const frontmatter = renderFrontmatter(metadata);
  let normalizedBody = body.replace(/^\n+/, "");
  if (normalizedBody && !normalizedBody.endsWith("\n")) {
    normalizedBody += "\n";
  }
  return `---\n${frontmatter}---\n\n${normalizedBody}`;
}

// ──────────────────────────────────────────────────────────────────────────
// Datetime helpers (ISO-8601 UTC <-> epoch millis)
// ──────────────────────────────────────────────────────────────────────────

export function toIso(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function fromIso(value: unknown): number | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

// ──────────────────────────────────────────────────────────────────────────
// Entrypoint (MEMORY.md) truncation — mirrors Python schema.py
// ──────────────────────────────────────────────────────────────────────────

export interface EntrypointView {
  content: string;
  wasTruncated: boolean;
  reason: string;
}

/** Bound `MEMORY.md` by line count and UTF-8 byte count. */
export function truncateEntrypointContent(
  raw: string,
  maxLines = MAX_ENTRYPOINT_LINES,
  maxBytes = MAX_ENTRYPOINT_BYTES,
): EntrypointView {
  const lines = raw.split(/\r?\n/);
  const wasLineTruncated = lines.length > maxLines;
  let text = lines.slice(0, maxLines).join("\n");
  let encoded = Buffer.from(text, "utf-8");
  const wasByteTruncated = encoded.length > maxBytes;
  if (wasByteTruncated) {
    encoded = encoded.subarray(0, maxBytes);
    text = encoded.toString("utf-8");
    const cutAt = text.lastIndexOf("\n");
    if (cutAt > 0) text = text.slice(0, cutAt);
  }
  if (!wasLineTruncated && !wasByteTruncated) {
    return { content: text, wasTruncated: false, reason: "" };
  }
  const reason = wasByteTruncated
    ? `${Buffer.from(raw, "utf-8").length} bytes (limit: ${maxBytes})`
    : `${lines.length} lines (limit: ${maxLines})`;
  const warning = `\n\n> WARNING: MEMORY.md is ${reason}. Only part of it was loaded. Keep index entries one line and move detail into topic notes.\n`;
  return { content: text.trimEnd() + warning, wasTruncated: true, reason };
}

// ──────────────────────────────────────────────────────────────────────────
// MemoryManager
// ──────────────────────────────────────────────────────────────────────────

export function parseMemoryType(raw: unknown): MemoryType | undefined {
  if (typeof raw !== "string") return undefined;
  const v = raw.trim().toLowerCase();
  if ((MEMORY_TYPES as readonly string[]).includes(v)) return v as MemoryType;
  return undefined;
}

export function parseMemoryScope(raw: unknown): MemoryScope | undefined {
  if (typeof raw !== "string") return undefined;
  const v = raw.trim().toLowerCase();
  if ((MEMORY_SCOPES as readonly string[]).includes(v)) return v as MemoryScope;
  if (v === "personal" || v === "user") return "private";
  if (v === "shared") return "team";
  return undefined;
}

export function coerceInt(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string") {
    const n = Number.parseInt(value, 10);
    if (!Number.isNaN(n)) return n;
  }
  return fallback;
}

export function entryToMetadata(entry: MemoryEntry): Record<string, unknown> {
  const meta: Record<string, unknown> = {
    schema_version: SCHEMA_VERSION,
    id: entry.id,
    name: entry.name ?? entry.id,
    description: entry.description ?? "",
    type: entry.type ?? DEFAULT_MEMORY_TYPE,
    scope: entry.scope ?? DEFAULT_MEMORY_SCOPE,
    importance: entry.importance ?? 0,
    signature: entry.signature ?? "",
    created_at: toIso(entry.createdAt),
    updated_at: toIso(entry.updatedAt),
    use_count: entry.useCount ?? 0,
  };
  if (entry.lastUsedAt) meta.last_used_at = toIso(entry.lastUsedAt);
  if (entry.tags?.length) meta.tags = entry.tags;
  if (entry.metadata) {
    for (const [k, v] of Object.entries(entry.metadata)) {
      if (!(k in meta)) meta[k] = v;
    }
  }
  return meta;
}

export function metadataToEntry(
  metadata: Record<string, unknown>,
  body: string,
): MemoryEntry {
  if (!body.trim()) throw new Error("Memory content must not be empty");
  if (metadata.schema_version !== SCHEMA_VERSION) {
    throw new Error(
      `Unsupported memory schema version ${String(metadata.schema_version)}; expected ${SCHEMA_VERSION}`,
    );
  }
  for (const field of ["id", "name", "description", "type", "scope", "importance", "signature", "created_at", "updated_at", "use_count"] as const) {
    if (metadata[field] === undefined || metadata[field] === "") {
      throw new Error(`Memory record is missing required field: ${field}`);
    }
  }
  const knownKeys = new Set<string>([
    ...FRONTMATTER_FIELDS,
    "category",
    "source",
  ]);
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(metadata)) {
    if (!knownKeys.has(k)) extra[k] = v;
  }
  const createdAt = fromIso(metadata.created_at);
  const updatedAt = fromIso(metadata.updated_at);
  const type = parseMemoryType(metadata.type);
  const scope = parseMemoryScope(metadata.scope);
  const importance = coerceInt(metadata.importance);
  const useCount = coerceInt(metadata.use_count);
  if (createdAt === undefined || updatedAt === undefined || !type || !scope || importance === undefined || useCount === undefined) {
    throw new Error("Memory record contains invalid typed frontmatter fields");
  }
  const tagsRaw = metadata.tags;
  const tags = Array.isArray(tagsRaw)
    ? tagsRaw.map((t) => String(t))
    : typeof tagsRaw === "string" && tagsRaw
      ? [tagsRaw]
      : undefined;
  return {
    id: String(metadata.id),
    content: body.replace(/^\n+/, "").replace(/\n+$/, ""),
    tags,
    createdAt,
    updatedAt,
    metadata: Object.keys(extra).length ? extra : undefined,
    name: metadata.name ? String(metadata.name) : undefined,
    description: String(metadata.description),
    type,
    scope,
    importance,
    signature: String(metadata.signature),
    useCount,
    lastUsedAt: fromIso(metadata.last_used_at),
  };
}

/** Return the first useful body line for descriptions. */
export function firstContentLine(body: string, limit = 200): string {
  for (const line of body.split(/\r?\n/)) {
    const stripped = line.trim();
    if (stripped && stripped !== "---" && !stripped.startsWith("#")) {
      return stripped.slice(0, limit);
    }
  }
  return "";
}

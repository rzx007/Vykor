import { isAbsolute, relative, resolve } from "node:path";

import {
  DEFAULT_MEMORY_SCOPE,
  DEFAULT_MEMORY_TYPE,
  parseMemoryScope,
  parseMemoryType,
  type MemoryScope,
  type MemoryType,
} from "./index.js";

export const MAX_MEMORY_EXTRACTION_RECORDS = 3;

export interface MemoryExtractionRecord {
  title: string;
  body: string;
  evidence?: string;
  memoryType: MemoryType;
  scope: MemoryScope;
  description: string;
  tags: string[];
}

function normalizeRecordLimit(maxRecords: number): number {
  if (!Number.isFinite(maxRecords)) return MAX_MEMORY_EXTRACTION_RECORDS;
  return Math.max(
    0,
    Math.min(MAX_MEMORY_EXTRACTION_RECORDS, Math.trunc(maxRecords)),
  );
}

/** Build the common prompt after each caller has adapted its message shape. */
export function buildMemoryExtractionPrompt(
  existingManifest: string,
  transcriptLines: readonly string[],
  maxRecords = MAX_MEMORY_EXTRACTION_RECORDS,
): string {
  const limit = normalizeRecordLimit(maxRecords);
  return [
    "Extract only durable memories from the recent conversation.",
    `Return JSON with at most ${limit} records. Existing memory manifest:`,
    existingManifest || "(empty)",
    "",
    "Recent conversation:",
    transcriptLines.join("\n"),
    "",
    'For each memory, include evidence copied exactly from a recent user message. Do not use assistant or tool text as evidence.',
    'JSON schema: {"memories":[{"title":"...","type":"user|feedback|project|reference","scope":"private|project|team","description":"...","body":"...","evidence":"exact user quote","tags":["..."]}]}',
  ].join("\n");
}

/** Parse a model response containing one noisy JSON object into normalized records. */
export function parseMemoryExtractionRecords(
  text: string,
  maxRecords = MAX_MEMORY_EXTRACTION_RECORDS,
): MemoryExtractionRecord[] {
  const stripped = text.trim();
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start < 0 || end <= start) return [];

  let payload: unknown;
  try {
    payload = JSON.parse(stripped.slice(start, end + 1));
  } catch {
    return [];
  }

  const rawRecords =
    payload && typeof payload === "object"
      ? (payload as { memories?: unknown }).memories
      : undefined;
  if (!Array.isArray(rawRecords)) return [];

  return rawRecords
    .slice(0, normalizeRecordLimit(maxRecords))
    .flatMap((candidate): MemoryExtractionRecord[] => {
      if (!candidate || typeof candidate !== "object") return [];
      const row = candidate as Record<string, unknown>;
      const title = String(row.title ?? "").trim();
      const body = String(row.body ?? "").trim();
      if (!title || !body) return [];
      return [
        {
          title,
          body,
          evidence: String(row.evidence ?? "").trim(),
          description: String(row.description ?? "").trim(),
          memoryType: parseMemoryType(row.type) ?? DEFAULT_MEMORY_TYPE,
          scope: parseMemoryScope(row.scope) ?? DEFAULT_MEMORY_SCOPE,
          tags: Array.isArray(row.tags)
            ? row.tags.map((tag) => String(tag).trim()).filter(Boolean)
            : [],
        },
      ];
    });
}

/** Team memories are not writable until the TypeScript store supports team isolation. */
export function selectWritableMemoryExtractionRecords(
  records: readonly MemoryExtractionRecord[],
  maxRecords = MAX_MEMORY_EXTRACTION_RECORDS,
): MemoryExtractionRecord[] {
  return records
    .filter((record) => record.scope !== "team")
    .slice(0, normalizeRecordLimit(maxRecords));
}

/** Detect a supported write tool call whose target is inside the memory directory. */
export function isMemoryWriteToolCall(
  toolName: string,
  input: Readonly<Record<string, unknown>>,
  memoryDir: string,
  cwd?: string,
): boolean {
  if (toolName !== "Write" && toolName !== "Edit") return false;
  const rawPath = String(input.path ?? input.file_path ?? "");
  if (!rawPath) return false;

  const root = resolve(memoryDir);
  const writeBase = cwd ? resolve(cwd) : root;
  const target = resolve(isAbsolute(rawPath) ? rawPath : resolve(writeBase, rawPath));
  const pathFromRoot = relative(root, target);
  return (
    pathFromRoot === "" ||
    (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot))
  );
}

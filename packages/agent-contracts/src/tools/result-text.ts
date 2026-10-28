import type { ToolExecutionResult } from "./tool-data.js";
import type { ToolResultList, ToolResultPage, ToolResultRef, ToolResultSearch } from "./result-data.js";

export class ToolResultAccessError extends Error {
  constructor(message: string, readonly failureKind: "invalid_input" | "policy" = "policy") { super(message); this.name = "ToolResultAccessError"; }
}

/** Offsets are JavaScript string (UTF-16) positions, identical for memory and persisted results. */
export function toolResultText(result: Pick<ToolExecutionResult, "content">): string {
  return result.content.map(block => block.type === "text" ? block.text : `[${block.type} content omitted]`).join("\n");
}

export function toolResultBounds(input: { offset?: number; limit?: number }, maximum: number, defaultLimit: number, total?: number): { offset: number; limit: number } {
  const offset = input.offset ?? 0, limit = input.limit ?? defaultLimit;
  if (!Number.isSafeInteger(offset) || offset < 0 || (total !== undefined && offset > total)
    || !Number.isSafeInteger(limit) || limit < 1 || limit > maximum) {
    throw new ToolResultAccessError(`Provide a nonnegative integer offset within the result and an integer limit from 1 to ${maximum}.`, "invalid_input");
  }
  return { offset, limit };
}

export function toolResultPage(ref: ToolResultRef, text: string, input: { offset?: number; limit?: number }): ToolResultPage {
  const { offset, limit } = toolResultBounds(input, 16_000, 8_000, text.length);
  const end = Math.min(text.length, offset + limit);
  return { ref: { ...ref }, text: text.slice(offset, end), offset, ...(end < text.length ? { nextOffset: end } : {}) };
}

export function toolResultList(items: readonly ToolResultRef[], input: { offset?: number; limit?: number } = {}): ToolResultList {
  const { offset, limit } = toolResultBounds(input, 100, 20, items.length), end = Math.min(items.length, offset + limit);
  return { items: items.slice(offset, end).map(item => ({ ...item })), ...(end < items.length ? { nextOffset: end } : {}) };
}

/** Literal, case-sensitive search. Advancing one position also preserves overlapping matches. */
export function toolResultSearch(ref: ToolResultRef, text: string, input: { query: string; offset?: number; limit?: number }): ToolResultSearch {
  const { offset, limit } = toolResultBounds(input, 100, 20, text.length);
  if (typeof input.query !== "string" || input.query.length === 0 || input.query.length > 1_000) throw new ToolResultAccessError("Provide a nonempty literal query of at most 1000 characters.", "invalid_input");
  const matches: ToolResultSearch["matches"] = [];
  let cursor = offset, found = text.indexOf(input.query, cursor);
  while (found !== -1 && matches.length < limit) {
    matches.push({ offset: found, text: text.slice(found, found + input.query.length) });
    cursor = found + 1;
    found = text.indexOf(input.query, cursor);
  }
  return { ref: { ...ref }, matches, ...(found !== -1 ? { nextOffset: cursor } : {}) };
}

export function assertToolResultId(id: unknown): asserts id is string {
  if (typeof id !== "string" || !/^result:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) throw new ToolResultAccessError("Provide an opaque result reference id.", "invalid_input");
}

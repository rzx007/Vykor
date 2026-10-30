import { SessionFileError } from "./records.js";
import type { SessionFileListInput, SessionFileStatInput, SessionFileReadInput, SessionFileFindInput, SessionFileSearchInput } from "./records.js";

function invalid(field: string): never {
  throw new SessionFileError("file_invalid_request", `Invalid file request field: ${field}`);
}

function inputObject(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!isSessionFileDataObject(value)) invalid("request");
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !fields.includes(key)) invalid("request");
  }
  return value;
}

export function isSessionFileDataObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function isSessionFileRelativePath(value: string): boolean {
  return value.length > 0 && value.length <= 4096 &&
    !value.startsWith("/") && !/^[a-zA-Z]:\//.test(value) &&
    !value.includes("\\") && !value.includes("\0") &&
    !value.split("/").includes("..");
}

function inputPath(value: unknown): string {
  if (typeof value !== "string" || !isSessionFileRelativePath(value)) invalid("path");
  return value;
}

function optionalPath(input: Record<string, unknown>): { path?: string } {
  return input.path === undefined ? {} : { path: inputPath(input.path) };
}

function inputText(value: unknown, field: string, glob = false): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 256 || value.includes("\0") || (field === "query" && /[\r\n]/.test(value))) invalid(field);
  if (glob && !isSessionFileRelativePath(value)) invalid(field);
  return value;
}

function inputInteger(value: unknown, max: number, field: string): number {
  const parsed = typeof value === "string" && /^[0-9]+$/.test(value) ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) invalid(field);
  return parsed;
}

function optionalLimit(input: Record<string, unknown>, max: number): { limit?: number } {
  return input.limit === undefined ? {} : { limit: inputInteger(input.limit, max, "limit") };
}

/** Request parsers accept decimal HTTP integers and `true`/`false`, preserving omitted options. */
export function parseSessionFileListInput(value: unknown): SessionFileListInput {
  const input = inputObject(value, ["path", "limit"]);
  return { ...optionalPath(input), ...optionalLimit(input, 1000) };
}

export function parseSessionFileStatInput(value: unknown): SessionFileStatInput {
  const input = inputObject(value, ["path"]);
  return { path: inputPath(input.path) };
}

export function parseSessionFileReadInput(value: unknown): SessionFileReadInput {
  const input = inputObject(value, ["path", "maxBytes"]);
  return {
    path: inputPath(input.path),
    ...(input.maxBytes === undefined ? {} : { maxBytes: inputInteger(input.maxBytes, 1048576, "maxBytes") }),
  };
}

export function parseSessionFileFindInput(value: unknown): SessionFileFindInput {
  const input = inputObject(value, ["pattern", "path", "limit"]);
  return { pattern: inputText(input.pattern, "pattern", true), ...optionalPath(input), ...optionalLimit(input, 1000) };
}

export function parseSessionFileSearchInput(value: unknown): SessionFileSearchInput {
  const input = inputObject(value, ["query", "path", "include", "caseSensitive", "limit"]);
  let caseSensitive = input.caseSensitive;
  if (caseSensitive === "true") caseSensitive = true;
  if (caseSensitive === "false") caseSensitive = false;
  if (caseSensitive !== undefined && typeof caseSensitive !== "boolean") invalid("caseSensitive");
  return {
    query: inputText(input.query, "query"),
    ...optionalPath(input),
    ...(input.include === undefined ? {} : { include: inputText(input.include, "include", true) }),
    ...(caseSensitive === undefined ? {} : { caseSensitive }),
    ...optionalLimit(input, 200),
  };
}

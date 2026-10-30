import { ProtocolDataError } from "../serialization/serialization.js";
import { isSessionFileDataObject, isSessionFileRelativePath } from "@vykor/domain-contracts/files";
import type { SessionFileInfo, SessionDirectoryResult, SessionTextFileResult, SessionFindFilesResult, SessionFileSearchMatch, SessionSearchFilesResult } from "@vykor/domain-contracts/files";

export type { SessionFileInfo, SessionDirectoryResult, SessionTextFileResult, SessionFindFilesResult, SessionFileSearchMatch, SessionSearchFilesResult, SessionFileListInput, SessionFileStatInput, SessionFileReadInput, SessionFileFindInput, SessionFileSearchInput, SessionFileErrorCode } from "@vykor/domain-contracts/files";
export { SessionFileError, parseSessionFileListInput, parseSessionFileStatInput, parseSessionFileReadInput, parseSessionFileFindInput, parseSessionFileSearchInput } from "@vykor/domain-contracts/files";

function responseObject(value: unknown): Record<string, unknown> {
  if (!isSessionFileDataObject(value)) throw new ProtocolDataError("File response must be an object");
  return value;
}

function responseString(value: unknown, field: string): string {
  if (typeof value !== "string") throw new ProtocolDataError(`File response ${field} must be a string`, field);
  return value;
}

function responsePath(value: unknown): string {
  const path = responseString(value, "path");
  if (!isSessionFileRelativePath(path)) throw new ProtocolDataError("File response path must be relative to the workspace", "path");
  return path;
}

function responseTruncated(value: unknown): boolean {
  if (typeof value !== "boolean") throw new ProtocolDataError("File response truncated must be a boolean", "truncated");
  return value;
}

function responseArray<T>(value: unknown, field: string, decode: (item: unknown) => T): T[] {
  if (!Array.isArray(value)) throw new ProtocolDataError(`File response ${field} must be an array`, field);
  return value.map(decode);
}

export function decodeSessionFileInfo(value: unknown): SessionFileInfo {
  const data = responseObject(value);
  const path = responsePath(data.path);
  const name = responseString(data.name, "name");
  if (!name || /[/\\\0]/.test(name)) throw new ProtocolDataError("File response name must be a filename", "name");
  const kind = data.kind;
  if (kind !== "file" && kind !== "directory" && kind !== "symlink" && kind !== "other") {
    throw new ProtocolDataError("File response kind is invalid", "kind");
  }
  const sizeBytes = data.sizeBytes;
  if (sizeBytes !== undefined && (typeof sizeBytes !== "number" || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0)) {
    throw new ProtocolDataError("File response sizeBytes must be a nonnegative integer", "sizeBytes");
  }
  const modifiedAt = data.modifiedAt;
  if (modifiedAt !== undefined && (typeof modifiedAt !== "number" || !Number.isFinite(modifiedAt) || modifiedAt < 0)) {
    throw new ProtocolDataError("File response modifiedAt must be a nonnegative timestamp", "modifiedAt");
  }
  return { path, name, kind, ...(sizeBytes === undefined ? {} : { sizeBytes }), ...(modifiedAt === undefined ? {} : { modifiedAt }) };
}

export function decodeSessionDirectoryResult(value: unknown): SessionDirectoryResult {
  const data = responseObject(value);
  return { path: responsePath(data.path), entries: responseArray(data.entries, "entries", decodeSessionFileInfo), truncated: responseTruncated(data.truncated) };
}

export function decodeSessionTextFileResult(value: unknown): SessionTextFileResult {
  const data = responseObject(value);
  if (data.encoding !== "utf-8") throw new ProtocolDataError("File response encoding must be utf-8", "encoding");
  return { path: responsePath(data.path), content: responseString(data.content, "content"), encoding: "utf-8", truncated: responseTruncated(data.truncated) };
}

export function decodeSessionFindFilesResult(value: unknown): SessionFindFilesResult {
  const data = responseObject(value);
  return { path: responsePath(data.path), files: responseArray(data.files, "files", responsePath), truncated: responseTruncated(data.truncated) };
}

function decodeSearchMatch(value: unknown): SessionFileSearchMatch {
  const data = responseObject(value);
  const line = data.line;
  if (typeof line !== "number" || !Number.isSafeInteger(line) || line < 1) throw new ProtocolDataError("File match line must be a positive integer", "line");
  return { path: responsePath(data.path), line, text: responseString(data.text, "text") };
}

export function decodeSessionSearchFilesResult(value: unknown): SessionSearchFilesResult {
  const data = responseObject(value);
  return { path: responsePath(data.path), matches: responseArray(data.matches, "matches", decodeSearchMatch), truncated: responseTruncated(data.truncated) };
}

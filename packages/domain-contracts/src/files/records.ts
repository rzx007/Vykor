/** All paths use forward slashes relative to the session workspace; its root is `.`. */
export interface SessionFileInfo {
  path: string;
  name: string;
  kind: "file" | "directory" | "symlink" | "other";
  sizeBytes?: number;
  /** Last modification time in milliseconds since the Unix epoch. */
  modifiedAt?: number;
}

export interface SessionDirectoryResult {
  path: string;
  entries: SessionFileInfo[];
  truncated: boolean;
}

export interface SessionTextFileResult {
  path: string;
  content: string;
  encoding: "utf-8";
  truncated: boolean;
}

export interface SessionFindFilesResult {
  path: string;
  files: string[];
  truncated: boolean;
}

export interface SessionFileSearchMatch {
  path: string;
  /** One-based line number. */
  line: number;
  text: string;
}

export interface SessionSearchFilesResult {
  path: string;
  matches: SessionFileSearchMatch[];
  truncated: boolean;
}

export interface SessionFileListInput { path?: string; limit?: number }
export interface SessionFileStatInput { path: string }
export interface SessionFileReadInput { path: string; maxBytes?: number }
export interface SessionFileFindInput { pattern: string; path?: string; limit?: number }
export interface SessionFileSearchInput {
  query: string;
  path?: string;
  include?: string;
  caseSensitive?: boolean;
  limit?: number;
}

export type SessionFileErrorCode =
  | "file_invalid_request"
  | "file_forbidden"
  | "file_not_found"
  | "file_not_text"
  | "file_not_ready"
  | "file_not_supported"
  | "file_timeout"
  | "file_cancelled"
  | "file_operation_failed";

/** Stable file-operation failure without runtime or filesystem dependencies. */
export class SessionFileError extends Error {
  constructor(readonly code: SessionFileErrorCode, message: string) {
    super(message);
    this.name = "SessionFileError";
  }
}

/** One command's host-managed, bounded Shell output capture. */
export interface ShellOutputCapture {
  append(text: string): void;
  /** Idempotent. `complete` means all output was received, not that the command succeeded. */
  finish(complete: boolean): ShellOutputLogStatus;
}

export interface ShellOutputLogStatus {
  reference?: string;
  retainedBytes: number;
  discardedBytes: number;
  complete: boolean;
  available: boolean;
  reason?: string;
}

export type ShellOutputLogPage =
  | { status: "unavailable" | "invalid_cursor" }
  | { status: "ok"; text: string; nextCursor: number; eof: boolean; retainedBytes: number; discardedBytes: number; complete: boolean };

export interface ShellOutputLogSearchResult {
  status: "ok" | "unavailable" | "invalid_pattern" | "limit" | "timeout" | "search_unavailable";
  matches: Array<{ byteOffset: number; text: string }>;
  truncated: boolean;
}

export interface ShellOutputLogHost {
  begin(sessionId: string | undefined, inlineChars: number): ShellOutputCapture;
  read(input: { sessionId?: string; reference: string; cursor?: number; maxBytes?: number }): Promise<ShellOutputLogPage>;
  search(input: { sessionId?: string; reference: string; pattern: string; caseSensitive?: boolean; signal?: AbortSignal }): Promise<ShellOutputLogSearchResult>;
}

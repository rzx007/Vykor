import type { ToolExecutionResult } from "./tool-data.js";

/** Opaque handle into an authorized result store; never a filesystem path. */
export interface ToolResultRef { id: string; toolName: string; totalChars: number }
export interface ToolResultPage { ref: ToolResultRef; text: string; offset: number; nextOffset?: number }
export interface ToolResultSearch {
  ref: ToolResultRef;
  matches: Array<{ offset: number; text: string }>;
  nextOffset?: number;
}
export interface ToolResultList { items: ToolResultRef[]; nextOffset?: number }
/** Capability already bound by the host to one Run and its current authorization. */
export interface RunToolResultStore {
  retain(result: ToolExecutionResult, source?: { kind: string; id?: string }): Promise<ToolResultRef>;
  list(input?: { offset?: number; limit?: number }): Promise<ToolResultList>;
  read(input: { id: string; offset?: number; limit?: number }): Promise<ToolResultPage>;
  search(input: { id: string; query: string; offset?: number; limit?: number }): Promise<ToolResultSearch>;
}

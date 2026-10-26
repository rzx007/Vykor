import type { ToolExecutionResult, ToolResultRef, ToolResultPage, ToolResultSearch, ToolResultList } from "./tool-data.js";
export type { ToolResultRef, ToolResultPage, ToolResultSearch, ToolResultList } from "./tool-data.js";

/** Capability already bound by the host to one Run and its current authorization. */
export interface RunToolResultStore {
  retain(result: ToolExecutionResult, source?: { kind: string; id?: string }): Promise<ToolResultRef>;
  list(input?: { offset?: number; limit?: number }): Promise<ToolResultList>;
  read(input: { id: string; offset?: number; limit?: number }): Promise<ToolResultPage>;
  search(input: { id: string; query: string; offset?: number; limit?: number }): Promise<ToolResultSearch>;
}

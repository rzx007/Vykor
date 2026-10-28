import { assertToolResultId, ToolResultAccessError, toolResultBounds, toolResultPage, toolResultSearch, toolResultText, type ToolExecutionResult, type ToolResultRef } from "@vykor/agent-contracts/tool-data";
import type { ToolResultCandidate, ToolResultRepository } from "./tool-result-repository.js";
export interface ToolResultSource { toolName: string; source: { kind: string; id?: string } }
export interface StoredToolResultReference { ref: ToolResultRef; source: ToolResultSource["source"] }
type Authorize = (result: ToolResultSource) => boolean;
function source(row: ToolResultCandidate): ToolResultSource { return { toolName: row.toolName, source: { kind: row.sourceKind, ...(row.sourceId === null ? {} : { id: row.sourceId }) } }; }
function ref(row: ToolResultCandidate): ToolResultRef { return { id: `result:${row.id}`, toolName: row.toolName, totalChars: row.totalChars }; }
/** Authorize candidate metadata before loading any body; list never loads bodies. */
export class ToolResultReader {
  constructor(private readonly results: ToolResultRepository) {}
  private require(sessionId: string, id: string, allowed: Authorize): ToolResultCandidate {
    assertToolResultId(id);
    const row = this.results.get(id.slice(7));
    if (!row || row.sessionId !== sessionId || !allowed(source(row))) throw new ToolResultAccessError("Tool result reference is unavailable, expired or unauthorized.");
    return row;
  }
  retain(sessionId: string, runId: string, result: ToolExecutionResult, origin: ToolResultSource["source"]): ToolResultRef {
    if (result.executionState !== "completed") throw new ToolResultAccessError("Only complete returned results can be retained.");
    const text = toolResultText(result);
    return ref(this.results.save({ sessionId, runId, toolUseId: result.toolUseId, toolName: result.toolName, sourceKind: origin.kind, sourceId: origin.id ?? null, text, totalChars: text.length }));
  }
  list(sessionId: string, input: { offset?: number; limit?: number } = {}, allowed: Authorize = () => true) {
    const rows = this.results.list(sessionId).filter(row => allowed(source(row)));
    const { offset, limit } = toolResultBounds(input, 100, 20, rows.length), end = Math.min(rows.length, offset + limit);
    return { items: rows.slice(offset, end).map(ref), ...(end < rows.length ? { nextOffset: end } : {}) };
  }
  resolve(sessionId: string, id: string): StoredToolResultReference { const row = this.require(sessionId, id, () => true); return { ref: ref(row), source: source(row).source }; }
  read(sessionId: string, input: { id: string; offset?: number; limit?: number }, allowed: Authorize = () => true) {
    const row = this.require(sessionId, input.id, allowed); return toolResultPage(ref(row), this.results.readText(row.id), input);
  }
  search(sessionId: string, input: { id: string; query: string; offset?: number; limit?: number }, allowed: Authorize = () => true) {
    const row = this.require(sessionId, input.id, allowed); return toolResultSearch(ref(row), this.results.readText(row.id), input);
  }
}

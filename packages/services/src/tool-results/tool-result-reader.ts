import { assertToolResultId, ToolResultAccessError, toolResultBounds, toolResultPage, toolResultSearch, type ToolExecutionResult, type ToolResultRef } from "@vykor/agent-contracts/tool-data";
import type { ToolOperationRepository, ToolResultCandidate } from "../tool-operations/tool-operation-repository.js";

export interface ToolResultSource { toolName: string; source: { kind: string; id?: string } }
export interface StoredToolResultReference { ref: ToolResultRef; source: ToolResultSource["source"] }
type Authorize = (result: ToolResultSource) => boolean;
interface Candidate extends ToolResultCandidate { source: ToolResultSource["source"] }
const sourceKinds = new Set(["builtin", "agent", "extension", "plugin", "mcp", "runtime"]);
function candidate(row: ToolResultCandidate): Candidate | undefined {
  // S1 persisted this envelope; old implementation versions do not restrict historical reads.
  try {
    const source = (JSON.parse(row.toolIdentity) as { source?: { kind?: unknown; id?: unknown } })?.source;
    if (!source || typeof source.kind !== "string" || !sourceKinds.has(source.kind)
      || (source.id !== undefined && typeof source.id !== "string")) return;
    return { ...row, source: { kind: source.kind, ...(source.id === undefined ? {} : { id: source.id }) } };
  } catch { return; }
}
function id(row: ToolResultCandidate): string { return `result:${row.operationId}:${row.activeAttemptId ?? "none"}`; }

/** Candidate metadata is authorized before loading text. No second body store or database table. */
export class ToolResultReader {
  constructor(private readonly operations: Pick<ToolOperationRepository, "getResultCandidate" | "listResultCandidates" | "readResultText">) {}
  private require(sessionId: string, refId: string, allowed: Authorize): Candidate {
    assertToolResultId(refId);
    const match = /^result:(operation_[0-9a-f-]{36}):(none|tool_attempt_[0-9a-f-]{36})$/.exec(refId);
    const row = match ? this.operations.getResultCandidate(match[1]!) : undefined;
    const result = row && row.sessionId === sessionId && id(row) === refId ? candidate(row) : undefined;
    if (!result || !allowed(result)) throw new ToolResultAccessError("Tool result reference is unavailable, expired or unauthorized.");
    return result;
  }
  private load(row: Candidate): { ref: ToolResultRef; text: string } {
    const text = this.operations.readResultText(row.operationId);
    return { ref: { id: id(row), toolName: row.toolName, totalChars: text.length }, text };
  }
  retain(sessionId: string, runId: string, result: ToolExecutionResult, allowed: Authorize = () => true): ToolResultRef {
    // Caller resultRef never chooses storage identity.
    const row = result.operationId ? this.operations.getResultCandidate(result.operationId) : undefined;
    const stored = row && row.sessionId === sessionId && row.runId === runId && row.toolName === result.toolName
      && row.toolCallId === result.toolUseId && (result.toolAttemptId === undefined || result.toolAttemptId === row.activeAttemptId)
      ? candidate(row) : undefined;
    if (!stored || !allowed(stored)) throw new ToolResultAccessError("Complete tool result was not retained or authorized in the S1 operation record.");
    return this.load(stored).ref;
  }
  list(sessionId: string, input: { offset?: number; limit?: number } = {}, allowed: Authorize = () => true) {
    const candidates = this.operations.listResultCandidates(sessionId).flatMap(row => {
      const result = candidate(row);
      return result && allowed(result) ? [result] : [];
    });
    const { offset, limit } = toolResultBounds(input, 100, 20, candidates.length);
    const end = Math.min(candidates.length, offset + limit);
    return { items: candidates.slice(offset, end).map(row => this.load(row).ref),
      ...(end < candidates.length ? { nextOffset: end } : {}) };
  }
  resolve(sessionId: string, refId: string): StoredToolResultReference {
    const row = this.require(sessionId, refId, () => true);
    return { ref: this.load(row).ref, source: row.source };
  }
  read(sessionId: string, input: { id: string; offset?: number; limit?: number }, allowed: Authorize = () => true) {
    const { ref, text } = this.load(this.require(sessionId, input.id, allowed));
    return toolResultPage(ref, text, input);
  }
  search(sessionId: string, input: { id: string; query: string; offset?: number; limit?: number }, allowed: Authorize = () => true) {
    const { ref, text } = this.load(this.require(sessionId, input.id, allowed));
    return toolResultSearch(ref, text, input);
  }
}

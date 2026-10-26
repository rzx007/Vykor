import { assertToolResultId, ToolResultAccessError, toolResultPage, toolResultSearch, toolResultText, type ToolExecutionResult, type ToolResultRef } from "@vykor/agent-contracts/tool-data";
import type { ToolOperationRecord } from "@vykor/domain-contracts/executions";
import type { ToolOperationRepository } from "../tool-operations/tool-operation-repository.js";

export interface StoredToolResultReference { ref: ToolResultRef; source: { kind: string; id?: string } }
const sourceKinds = new Set(["builtin", "agent", "extension", "plugin", "mcp", "runtime"]);
function readSource(identity: string): StoredToolResultReference["source"] | undefined {
  // S1 already persisted this JSON envelope. Implementation versions are irrelevant for historical reads.
  try {
    const source = (JSON.parse(identity) as { source?: { kind?: unknown; id?: unknown } })?.source;
    if (!source || typeof source.kind !== "string" || !sourceKinds.has(source.kind)
      || (source.id !== undefined && typeof source.id !== "string")) return;
    return { kind: source.kind, ...(source.id === undefined ? {} : { id: source.id }) };
  } catch { return; }
}
function available(row: ToolOperationRecord): boolean {
  return ["confirmed", "not_applied"].includes(row.state) && row.result?.executionState === "completed";
}
function id(row: ToolOperationRecord): string { return `result:${row.operationId}:${row.activeAttemptId ?? "none"}`; }

/** Read-only view over the existing S1 result. No second body store or database table. */
export class ToolResultReader {
  constructor(private readonly operations: Pick<ToolOperationRepository, "get" | "list">) {}
  private reference(row: ToolOperationRecord): StoredToolResultReference | undefined {
    const source = readSource(row.toolIdentity);
    if (!available(row) || !source) return;
    return { ref: { id: id(row), toolName: row.toolName, totalChars: toolResultText(row.result!).length }, source };
  }
  private require(sessionId: string, refId: string): { row: ToolOperationRecord; reference: StoredToolResultReference } {
    assertToolResultId(refId);
    const match = /^result:(operation_[0-9a-f-]{36}):(none|tool_attempt_[0-9a-f-]{36})$/.exec(refId);
    const row = match ? this.operations.get(match[1]!) : undefined;
    const reference = row && row.sessionId === sessionId && id(row) === refId ? this.reference(row) : undefined;
    if (!row || !reference) throw new ToolResultAccessError("Tool result reference is unavailable, expired or unauthorized.");
    return { row, reference };
  }
  retain(sessionId: string, runId: string, result: ToolExecutionResult): ToolResultRef {
    // The execution result's operation identity is supplied by checked execution; resultRef is never trusted.
    const row = result.operationId ? this.operations.get(result.operationId) : undefined;
    const reference = row && row.sessionId === sessionId && row.runId === runId && row.toolName === result.toolName
      && row.toolCallId === result.toolUseId && (result.toolAttemptId === undefined || result.toolAttemptId === row.activeAttemptId)
      ? this.reference(row) : undefined;
    if (!reference) throw new ToolResultAccessError("Complete tool result was not retained in the S1 operation record.");
    return { ...reference.ref };
  }
  list(sessionId: string): StoredToolResultReference[] {
    return this.operations.list({ sessionId }).flatMap(row => { const reference = this.reference(row); return reference ? [reference] : []; });
  }
  resolve(sessionId: string, refId: string): StoredToolResultReference { return this.require(sessionId, refId).reference; }
  read(sessionId: string, input: { id: string; offset?: number; limit?: number }) {
    const { row, reference } = this.require(sessionId, input.id);
    return toolResultPage(reference.ref, toolResultText(row.result!), input);
  }
  search(sessionId: string, input: { id: string; query: string; offset?: number; limit?: number }) {
    const { row, reference } = this.require(sessionId, input.id);
    return toolResultSearch(reference.ref, toolResultText(row.result!), input);
  }
}

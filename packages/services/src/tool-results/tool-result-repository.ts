import { randomUUID } from "node:crypto";
import type { StorageContext } from "../database/storage-context.js";
import { assertMutableSession, assertSession } from "../session-runtime/persistence/store-state.js";
export interface ToolResultRecord {
  id: string; sessionId: string; runId: string; toolUseId: string; toolName: string;
  sourceKind: string; sourceId: string | null; text: string; totalChars: number; createdAt: number;
}
export type ToolResultCandidate = Omit<ToolResultRecord, "text">;
function metadata({ text: _text, ...row }: ToolResultRecord): ToolResultCandidate { return row; }
/** Immutable completed result bodies. No intent, dispatch or execution state is stored. */
export class ToolResultRepository {
  constructor(private readonly storage: StorageContext) {}
  save(input: Omit<ToolResultRecord, "id" | "createdAt">): ToolResultCandidate {
    return this.storage.atomic(() => {
      this.storage.assertWritable?.();
      assertMutableSession(assertSession(this.storage.state, input.sessionId));
      const run = this.storage.state.runs[input.runId];
      if (!run || run.sessionId !== input.sessionId || !["pending", "running"].includes(run.status)) throw new Error("Tool result Run is unavailable");
      const row = { ...input, id: randomUUID(), createdAt: Date.now() };
      this.storage.rollback?.capture(this.storage.state.toolResults, row.id);
      this.storage.state.toolResults[row.id] = row;
      this.storage.mutations.toolResults.add(row.id);
      return metadata(row);
    });
  }
  get(id: string): ToolResultCandidate | undefined { const row = this.storage.state.toolResults[id]; return row && metadata(row); }
  list(sessionId: string): ToolResultCandidate[] { return Object.values(this.storage.state.toolResults).filter(row => row.sessionId === sessionId).map(metadata); }
  readText(id: string): string { const row = this.storage.state.toolResults[id]; if (!row) throw new Error("Tool result unavailable"); return row.text; }
}

import type { AgentRunScope, RunToolBinding, RunToolResultStore, ToolExecutionResult, ToolRegistrationSource, ToolResultRef } from "@vykor/agent-contracts";
import { assertToolResultId, ToolResultAccessError, toolResultList, toolResultPage, toolResultSearch, toolResultText } from "./result-text.js";

export interface MemoryToolResultArchiveOptions { maxEntries?: number; maxTotalChars?: number }
interface Entry { ref: ToolResultRef; text: string; sessionId: string; source: { kind: string; id?: string }; key: string }
function source(binding: RunToolBinding): ToolRegistrationSource { return binding.source ?? { kind: "runtime" }; }
function sameSource(a: { kind: string; id?: string }, b: { kind: string; id?: string }): boolean { return a.kind === b.kind && a.id === b.id; }

/** One bounded archive per SDK Agent; bound views carry current authorization, never model identity. */
export class MemoryToolResultArchive {
  private readonly entries = new Map<string, Entry>();
  private readonly keys = new Map<string, string>();
  private readonly activeRuns = new Map<string, Set<{ active: boolean; release(): void }>>();
  private totalChars = 0;
  private readonly maxEntries: number;
  private readonly maxTotalChars: number;
  constructor(options: MemoryToolResultArchiveOptions = {}) {
    this.maxEntries = options.maxEntries ?? 200;
    this.maxTotalChars = options.maxTotalChars ?? 8 * 1024 * 1024;
    if (![this.maxEntries, this.maxTotalChars].every(value => Number.isSafeInteger(value) && value > 0)) throw new ToolResultAccessError("Result archive capacity must be a positive integer.", "invalid_input");
  }
  /** Invalidate normally completed Run capabilities while retaining their bounded historical entries. */
  releaseRun(runId: string): void {
    for (const token of this.activeRuns.get(runId) ?? []) token.release();
    this.activeRuns.delete(runId);
  }
  forRun(scope: AgentRunScope, bindings: ReadonlyMap<string, RunToolBinding>): RunToolResultStore {
    const sessionId = scope.sessionId, runId = scope.runId, signal = scope.signal;
    const tokens = this.activeRuns.get(runId) ?? new Set<{ active: boolean; release(): void }>();
    const token = { active: !signal.aborted, release: () => {
      token.active = false; tokens.delete(token); signal.removeEventListener("abort", token.release);
      if (tokens.size === 0) this.activeRuns.delete(runId);
    } };
    if (token.active) { tokens.add(token); this.activeRuns.set(runId, tokens); signal.addEventListener("abort", token.release, { once: true }); }
    const assertRun = () => { if (!token.active || signal.aborted) throw new ToolResultAccessError("Tool result Run is no longer active."); };
    const allowed = (entry: Entry) => entry.sessionId === sessionId && !!bindings.get(entry.ref.toolName)
      && sameSource(entry.source, source(bindings.get(entry.ref.toolName)!));
    const get = (id: string) => {
      assertRun(); assertToolResultId(id);
      const entry = this.entries.get(id);
      if (!entry || !allowed(entry)) throw new ToolResultAccessError("Tool result reference is unavailable, expired or unauthorized.");
      return entry;
    };
    return {
      retain: async (result, claimedSource) => {
        assertRun();
        if (result.executionState !== "completed") throw new ToolResultAccessError("Unknown execution outcome has no complete tool result reference.");
        const binding = bindings.get(result.toolName);
        if (!binding) throw new ToolResultAccessError("Tool result source is not authorized for this Run.");
        const actual = source(binding);
        if (claimedSource && !sameSource(actual, claimedSource)) throw new ToolResultAccessError("Tool result source does not match the captured binding.");
        // resultRef comes from untrusted tool output and never chooses storage identity.
        const key = JSON.stringify([sessionId, runId, result.toolAttemptId ?? result.toolUseId, result.toolName, actual.kind, actual.id]);
        const existing = this.keys.get(key);
        if (existing) return { ...get(existing).ref };
        const text = toolResultText(result);
        if (text.length > this.maxTotalChars) throw new ToolResultAccessError("Tool result exceeds memory archive capacity; complete output was not retained.");
        while (this.entries.size >= this.maxEntries || this.totalChars + text.length > this.maxTotalChars) {
          const oldest = this.entries.values().next().value as Entry;
          this.entries.delete(oldest.ref.id); this.keys.delete(oldest.key); this.totalChars -= oldest.text.length;
        }
        const ref = { id: `result:${crypto.randomUUID()}`, toolName: result.toolName, totalChars: text.length };
        this.entries.set(ref.id, { ref, text, sessionId, source: { ...actual }, key });
        this.keys.set(key, ref.id); this.totalChars += text.length;
        return { ...ref };
      },
      list: async input => { assertRun(); return toolResultList([...this.entries.values()].filter(allowed).map(entry => entry.ref), input); },
      read: async input => { const entry = get(input.id); return toolResultPage(entry.ref, entry.text, input); },
      search: async input => { const entry = get(input.id); return toolResultSearch(entry.ref, entry.text, input); },
    };
  }
}

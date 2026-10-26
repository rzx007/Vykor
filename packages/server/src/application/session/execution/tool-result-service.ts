import type { AgentRunScope, RunToolBinding, RunToolResultStore } from "@vykor/agent-contracts";
import { isToolResultReader, ToolResultAccessError } from "@vykor/core";
import { readSessionRuntimeRevision } from "@vykor/domain-contracts/sessions";
import { ToolResultReader, type ApplicationOwnerLease, type SessionStore, type ToolResultSource } from "@vykor/services";

export interface ToolResultServiceOptions {
  store: Pick<SessionStore, "transaction" | "assertApplicationOwner" | "sessions" | "runs" | "toolOperations">;
  ownerLease(): ApplicationOwnerLease;
  accepting?(): boolean;
}

/** Historical reads require today's exact session, live Run and captured tool/source authorization. */
export class ToolResultService {
  private readonly reader: ToolResultReader;
  private readonly atomic: SessionStore["transaction"];
  private readonly assertLease: SessionStore["assertApplicationOwner"];
  constructor(private readonly options: ToolResultServiceOptions) {
    this.reader = new ToolResultReader(options.store.toolOperations);
    this.atomic = options.store.transaction.bind(options.store);
    this.assertLease = options.store.assertApplicationOwner.bind(options.store);
  }
  forRun(scope: AgentRunScope, bindings: ReadonlyMap<string, RunToolBinding>): RunToolResultStore {
    const captured = { ...scope };
    const revision = this.current(captured);
    const atomic = <T>(action: () => T): T => this.atomic(() => {
      if (this.current(captured) !== revision) throw new ToolResultAccessError("Tool result policy changed since Run capture.");
      return action();
    });
    const allowed = (reference: ToolResultSource): boolean => {
      const binding = bindings.get(reference.toolName);
      return !!binding?.source && binding.source.kind === reference.source.kind && binding.source.id === reference.source.id
        && !(binding.source.kind === "builtin" && isToolResultReader(binding.definition, binding.definitionIdentity));
    };
    return {
      retain: async (result, claimedSource) => atomic(() => {
        return this.reader.retain(captured.sessionId, captured.runId, result, reference => {
          if (!allowed(reference)) return false;
          if (claimedSource && (claimedSource.kind !== reference.source.kind || claimedSource.id !== reference.source.id)) throw new ToolResultAccessError("Tool result source does not match the captured binding.");
          return true;
        });
      }),
      list: async input => atomic(() => this.reader.list(captured.sessionId, input, allowed)),
      read: async input => atomic(() => this.reader.read(captured.sessionId, input, allowed)),
      search: async input => atomic(() => this.reader.search(captured.sessionId, input, allowed)),
    };
  }
  private current(scope: AgentRunScope): number {
    this.assertLease(this.options.ownerLease());
    if (this.options.accepting?.() === false || scope.signal.aborted) throw new ToolResultAccessError("Tool result Run is no longer active.");
    const session = this.options.store.sessions.get(scope.sessionId), run = this.options.store.runs.getRun(scope.runId);
    if (!session || session.status === "closing" || session.status === "archived") throw new ToolResultAccessError("Tool result session is unavailable.");
    if (scope.agentId !== session.id || scope.cwd !== session.cwd || !run || run.sessionId !== session.id
      || (run.inputId !== undefined && run.inputId !== scope.inputId) || (run.status !== "pending" && run.status !== "running")) throw new ToolResultAccessError("Tool result Run is terminal or does not belong to the current session.");
    return readSessionRuntimeRevision(session.metadata);
  }
}

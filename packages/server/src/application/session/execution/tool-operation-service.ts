import { randomUUID } from "node:crypto";
import type { AgentToolSafety, AgentRunScope, RunToolBinding, ToolOperationGate, ToolOperationIntent, ToolOperationKind } from "@vykor/agent-contracts";
import { readSessionRuntimeRevision } from "@vykor/domain-contracts/sessions";
import type { ApplicationOwnerLease, SessionStore } from "@vykor/services";
import type { AgentRunCapabilitySnapshot } from "@vykor/agent-runtime";

export interface TrustedToolOperationDescription {
  kind: ToolOperationKind;
  businessKey?: string;
}
export interface ToolOperationServiceOptions {
  store: Pick<SessionStore, "transaction" | "assertApplicationOwner" | "sessions" | "runs" | "executions" | "toolOperations">;
  ownerLease(): ApplicationOwnerLease;
  accepting?(): boolean;
  /** Trusted host code must verify captured implementation identity before granting replay/read promises. */
  describe?(intent: ToolOperationIntent): TrustedToolOperationDescription | undefined;
}

/** Binds the tool ledger to the daemon's actual owner, current session and Run. */
export class ToolOperationService implements AgentToolSafety {
  readonly operations: ToolOperationGate;
  readonly requiredPolicy: AgentToolSafety["requiredPolicy"];
  private readonly functionIds = new WeakMap<object, string>();
  private readonly symbolIds = new Map<symbol, string>();
  /** Receipt failures must stop sibling dispatch before async Run failure projection. */
  private readonly unsettledFailures = new Set<string>();
  /** Actual calls can outlive their Run; only their own promise releases manual review. */
  private readonly pendingInvocations = new Map<string, Promise<void>>();
  private readonly runs = new Map<string, { policyVersion: string; tools: ReadonlyMap<string, RunToolBinding>; environment?: unknown }>();
  private readonly atomic: SessionStore["transaction"];
  private readonly assertLease: SessionStore["assertApplicationOwner"];
  constructor(private readonly options: ToolOperationServiceOptions) {
    const { store } = options;
    this.atomic = store.transaction.bind(store);
    this.assertLease = store.assertApplicationOwner.bind(store);
    this.operations = {
      prepare: async intent => this.atomic(() => {
        this.assertCurrent(intent.scope);
        const captured = this.runs.get(intent.scope.runId);
        const binding = captured?.tools.get(intent.toolUse.name);
        const isCaptured = !captured || (!!binding && this.sameBinding(binding, intent.binding));
        const declared = isCaptured ? this.options.describe?.(intent) : undefined;
        return store.toolOperations.prepare({ ...intent, kind: declared?.kind ?? "non_replayable", businessKey: declared?.businessKey,
          toolIdentity: this.identity(intent, captured?.environment) });
      }),
      authorize: async input => this.atomic(() => {
        this.assertVersion(input.intent.scope, input.policyVersion);
        this.assertUnblocked(input.intent, input.operation.kind);
        return store.toolOperations.authorize(input);
      }),
      dispatch: async input => this.atomic(() => {
        this.assertVersion(input.intent.scope, input.policyVersion);
        this.assertUnblocked(input.intent, input.operation.kind);
        return store.toolOperations.dispatch({ ...input, ownerId: this.options.ownerLease().ownerId });
      }),
      observeInvocation: ({ receipt, settled }) => {
        this.atomic(() => {
          this.assertOwner();
          if (receipt.ownerId !== this.options.ownerLease().ownerId || !store.toolOperations.isCurrentDispatch(receipt.operationId, receipt.toolAttemptId))
            throw new Error("Tool invocation receipt is no longer current");
        });
        this.pendingInvocations.set(receipt.operationId, settled);
        const finished = () => {
          if (this.pendingInvocations.get(receipt.operationId) === settled) this.pendingInvocations.delete(receipt.operationId);
        };
        void settled.then(finished, finished);
      },
      settle: async input => {
        try {
          this.atomic(() => {
            this.assertOwner();
            if (input.receipt.ownerId !== this.options.ownerLease().ownerId) throw new Error("Tool receipt owner mismatch");
            store.toolOperations.settle(input);
          });
          this.clearResolvedFailure(input.receipt.operationId);
        } catch (error) {
          const operation = store.toolOperations.getSummary(input.receipt.operationId);
          if (operation?.state === "dispatching" || operation?.state === "unknown")
            this.unsettledFailures.add(input.receipt.operationId);
          throw error;
        }
      },
      reject: async input => this.atomic(() => {
        this.assertOwner();
        store.toolOperations.reject(input);
      }),
    };
    this.requiredPolicy = { check: async ({ intent, operation }) => {
      try {
        return this.atomic(() => {
          const policyVersion = this.assertCurrent(intent.scope);
          this.assertUnblocked(intent, operation.kind);
          return { allowed: true, policyVersion };
        });
      } catch (error) {
        return { allowed: false, policyVersion: "s1:denied", reason: error instanceof Error ? error.message : String(error) };
      }
    } };
  }
  /** Called after reliable Run start, using Node's captured bindings, never model metadata. */
  onRunCapabilities(snapshot: AgentRunCapabilitySnapshot): () => void {
    const captured = this.atomic(() => {
      const policyVersion = this.assertCurrent(snapshot.scope);
      this.options.store.executions.ensure({ sessionId: snapshot.scope.sessionId, runId: snapshot.scope.runId });
      return { policyVersion, tools: new Map([
        ...(snapshot.capabilityView.delegatableTools ?? []), ...(snapshot.capabilityView.appTools ?? []), ...snapshot.capabilityView.tools,
      ]), environment: snapshot.executionEnvironment };
    });
    this.runs.set(snapshot.scope.runId, captured);
    return () => { this.runs.delete(snapshot.scope.runId); };
  }
  recoverDispatching(): number {
    return this.atomic(() => { this.assertOwner(); return this.options.store.toolOperations.recoverDispatching(); });
  }
  /** Only authorized host-side read-only evidence may call this method. */
  reconcile(input: Parameters<SessionStore["toolOperations"]["reconcile"]>[0]) {
    const operation = this.atomic(() => {
      this.assertOwner();
      if (input.outcome !== "unknown" && this.pendingInvocations.has(input.operationId))
        throw new Error("Tool invocation is still executing; only unknown evidence may be recorded until it settles");
      return this.options.store.toolOperations.reconcile(input);
    });
    this.clearResolvedFailure(operation.operationId);
    return operation;
  }
  private clearResolvedFailure(operationId: string): void {
    const state = this.options.store.toolOperations.getSummary(operationId)?.state;
    if (state === "confirmed" || state === "not_applied") this.unsettledFailures.delete(operationId);
  }
  private assertOwner(): void { this.assertLease(this.options.ownerLease()); }
  private assertCurrent(scope: AgentRunScope): string {
    this.assertOwner();
    if (this.options.accepting?.() === false || scope.signal.aborted) throw new Error("Tool Run no longer accepts dispatch");
    const session = this.options.store.sessions.get(scope.sessionId), run = this.options.store.runs.getRun(scope.runId);
    if (!session || session.status === "closing" || session.status === "archived") throw new Error("Tool session is unavailable");
    if (scope.agentId !== session.id || scope.cwd !== session.cwd || !run || run.sessionId !== session.id
      || (run.inputId !== undefined && run.inputId !== scope.inputId)
      || (run.status !== "pending" && run.status !== "running")) throw new Error("Tool Run does not belong to the current session or is terminal");
    const policyVersion = `s1:runtime:${readSessionRuntimeRevision(session.metadata)}`;
    const captured = this.runs.get(scope.runId);
    if (captured && captured.policyVersion !== policyVersion) throw new Error("Tool policy changed since Run scope capture");
    return policyVersion;
  }
  private assertVersion(scope: AgentRunScope, version: string): void {
    if (this.assertCurrent(scope) !== version) throw new Error("Tool policy version changed before dispatch");
  }
  private assertUnblocked(intent: ToolOperationIntent, kind: ToolOperationKind): void {
    if (kind === "read_only") return;
    const rootSessionId = this.rootSessionId(intent.scope.sessionId);
    const blocked = this.options.store.toolOperations.listSafetyStates().find(row => {
      const settlementFailed = this.unsettledFailures.has(row.id);
      if (row.kind === "read_only" && !settlementFailed) return false;
      const run = row.state === "dispatching" ? this.options.store.runs.getRun(row.runId) : undefined;
      const unresolved = settlementFailed || row.state === "unknown" || (row.state === "dispatching"
        && (!run || (run.status !== "pending" && run.status !== "running")));
      return unresolved && this.rootSessionId(row.sessionId) === rootSessionId;
    });
    if (blocked) throw new Error(`Unknown or unresolved write operation ${blocked.id} blocks dangerous dispatch in this session tree; review with GET /sessions/${encodeURIComponent(rootSessionId)}/tool-operations`);
  }
  private rootSessionId(sessionId: string): string {
    const visited = new Set<string>();
    let current = sessionId;
    while (true) {
      if (visited.has(current)) throw new Error("Tool session ancestry is cyclic");
      visited.add(current);
      const session = this.options.store.sessions.get(current);
      if (!session) throw new Error("Tool session ancestry is unavailable");
      if (!session.parentId) return current;
      current = session.parentId;
    }
  }
  private sameBinding(captured: RunToolBinding, actual: RunToolBinding | undefined): boolean {
    return !!actual && captured.definitionIdentity === actual.definitionIdentity && captured.invoke === actual.invoke && captured.definition.execute === actual.definition.execute
      && captured.source?.kind === actual.source?.kind && captured.source?.id === actual.source?.id;
  }
  private identity(intent: ToolOperationIntent, environment: unknown): string {
    const binding = intent.binding;
    let definition: string | undefined;
    if (binding?.definitionIdentity) {
      definition = this.symbolIds.get(binding.definitionIdentity);
      if (!definition) { definition = randomUUID(); this.symbolIds.set(binding.definitionIdentity, definition); }
    }
    let implementation: string | undefined;
    if (binding?.invoke) {
      implementation = this.functionIds.get(binding.invoke);
      if (!implementation) { implementation = randomUUID(); this.functionIds.set(binding.invoke, implementation); }
    }
    return JSON.stringify({ source: binding?.source ?? { kind: "unknown" }, definition, implementation, cwd: intent.scope.cwd, environment });
  }
}

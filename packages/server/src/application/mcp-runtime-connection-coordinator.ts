import type {
  ActiveMcpRuntimeHandle,
  McpRuntimeConnectionCoordinator as McpRuntimeConnectionCoordinatorContract,
  McpRuntimeStatus,
  McpRuntimeSyncResult,
  McpRuntimeRegistry,
  McpServerIdentity,
} from "@vykor/core";

/**
 * Process-wide coordinator over the active MCP Runtimes.
 *
 * It owns one monotonic generation counter per server identity and serializes
 * `synchronize` calls per identity, so a logout cannot be overtaken by an
 * in-flight reconnect that started before it. Runtime handles are filtered by
 * the full identity (name + transport + endpoint fingerprint); same-name
 * servers in different projects never affect each other.
 */
export class McpRuntimeConnectionCoordinator
  implements McpRuntimeConnectionCoordinatorContract, McpRuntimeRegistry
{
  private readonly handles = new Map<string, ActiveMcpRuntimeHandle>();
  private readonly generations = new Map<string, number>();
  private readonly namedGenerations = new Map<string, number>();
  private readonly queues = new Map<string, Promise<unknown>>();

  register(handle: ActiveMcpRuntimeHandle): () => void {
    this.handles.set(handle.runtimeId, handle);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      if (this.handles.get(handle.runtimeId) === handle) {
        this.handles.delete(handle.runtimeId);
      }
    };
  }

  currentGeneration(identity: McpServerIdentity): number {
    return this.generations.get(identityKey(identity)) ?? 0;
  }

  currentNamedGeneration(name: string): number {
    return this.namedGenerations.get(name) ?? 0;
  }

  async getStatus(identity: McpServerIdentity): Promise<McpRuntimeSyncResult> {
    const participants = this.participants(identity);
    return {
      status: aggregateStatus(participants.map((handle) => handle.getStatus(identity))),
      affectedRuntimes: participants.length,
      failures: [],
    };
  }

  async synchronize(identity: McpServerIdentity): Promise<McpRuntimeSyncResult> {
    const key = identityKey(identity);
    return this.enqueue(key, async () => {
      const generation = (this.generations.get(key) ?? 0) + 1;
      this.generations.set(key, generation);

      const participants = this.participants(identity);
      const settled = await Promise.allSettled(
        participants.map((handle) => handle.synchronize(identity, generation)),
      );
      const failures = settled.flatMap((result, index) =>
        result.status === "rejected"
          ? [{ runtimeId: participants[index]!.runtimeId, message: describeError(result.reason) }]
          : [],
      );

      return {
        status: aggregateStatus(participants.map((handle) => handle.getStatus(identity))),
        affectedRuntimes: participants.length,
        failures,
      };
    });
  }

  private participants(identity: McpServerIdentity): ActiveMcpRuntimeHandle[] {
    return [...this.handles.values()].filter((handle) => {
      const candidate = handle.identity(identity.name);
      return (
        candidate !== undefined &&
        candidate.transport === identity.transport &&
        candidate.endpointFingerprint === identity.endpointFingerprint
      );
    });
  }

  /**
   * Reconcile the latest global config for `name` across every active Runtime.
   *
   * Unlike `synchronize`, this is keyed by server name and fans out to all
   * handles (a server may be stdio, SSE, newly added or previously disabled).
   * Runs are serialized per name and advance a name generation so a slow
   * connect can never override a later disable, delete or address change.
   */
  async reconcileGlobal(name: string): Promise<McpRuntimeSyncResult> {
    return this.enqueue(`global:${name}`, async () => {
      const generation = (this.namedGenerations.get(name) ?? 0) + 1;
      this.namedGenerations.set(name, generation);

      const participants = [...this.handles.values()];
      const settled = await Promise.allSettled(
        participants.map((handle) => handle.reconcileGlobal(name, generation)),
      );
      const failures = settled.flatMap((result, index) =>
        result.status === "rejected"
          ? [{ runtimeId: participants[index]!.runtimeId, message: describeError(result.reason) }]
          : [],
      );

      return {
        status: summarizeReconcile(participants.length, failures.length > 0),
        affectedRuntimes: participants.length,
        failures,
      };
    });
  }

  private enqueue<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const current = previous.then(operation, operation);
    const settled = current.then(
      () => undefined,
      () => undefined,
    );
    this.queues.set(key, settled);
    void settled.finally(() => {
      if (this.queues.get(key) === settled) this.queues.delete(key);
    });
    return current;
  }
}

function aggregateStatus(statuses: McpRuntimeStatus[]): McpRuntimeStatus {
  if (statuses.length === 0) return "unavailable";
  if (statuses.some((status) => status === "error")) return "error";
  if (statuses.every((status) => status === "connected")) return "connected";
  return "disconnected";
}

/**
 * Coarse result for a name-keyed reconcile. Callers care about `failures`; the
 * status only distinguishes "no active session" from "some session failed".
 */
function summarizeReconcile(
  participantCount: number,
  hasFailures: boolean,
): McpRuntimeStatus {
  if (participantCount === 0) return "unavailable";
  if (hasFailures) return "error";
  return "connected";
}

function describeError(error: unknown): string {
  // Exception messages are untrusted: SDK/network errors can contain tokens
  // or the complete endpoint query. The control plane exposes a stable,
  // secret-free summary instead of attempting incomplete pattern redaction.
  return error instanceof Error && error.name === "McpConnectionStageError"
    ? "MCP connection setup failed"
    : "MCP runtime synchronization failed";
}

function identityKey(identity: McpServerIdentity): string {
  return JSON.stringify([identity.transport, identity.name, identity.endpointFingerprint]);
}

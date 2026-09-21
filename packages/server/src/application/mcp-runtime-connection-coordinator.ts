import type {
  ActiveMcpRuntimeHandle,
  McpRuntimeConnectionCoordinator as McpRuntimeConnectionCoordinatorContract,
  McpRuntimeStatus,
  McpRuntimeSyncResult,
  McpRuntimeRegistry,
  McpServerIdentity,
} from "@openharness/core";

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
    return this.generations.get(identity.endpointFingerprint) ?? 0;
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
    const key = identity.endpointFingerprint;
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

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

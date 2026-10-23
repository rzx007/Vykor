import type { McpServerIdentity, McpRuntimeSyncResult, McpRuntimeStatus } from "@vykor/host-config";

/** Reconnects or disconnects the active Runtimes matching one server identity. */
export interface McpRuntimeConnectionCoordinator {
  getStatus(identity: McpServerIdentity): Promise<McpRuntimeSyncResult>;
  synchronize(identity: McpServerIdentity): Promise<McpRuntimeSyncResult>;
  /**
   * Reconcile every active Runtime against the latest global configuration for
   * `name`. Unlike {@link synchronize}, this is keyed by server name (so stdio
   * and SSE servers participate) and each Runtime decides whether it owns the
   * name from global settings.
   */
  reconcileGlobal(name: string): Promise<McpRuntimeSyncResult>;
}

/**
 * Narrow capability one active Session Runtime exposes to the coordinator.
 *
 * `synchronize` must check the generation before staging a connection and again
 * before publishing it. `getStatus` maps the Runtime's internal state onto
 * `McpRuntimeStatus` (initializing maps to `disconnected`).
 */
export interface ActiveMcpRuntimeHandle {
  runtimeId: string;
  identity(name: string): McpServerIdentity | undefined;
  synchronize(identity: McpServerIdentity, generation: number): Promise<void>;
  /** Re-check the latest global config for `name` and connect/disconnect accordingly. */
  reconcileGlobal(name: string, generation: number): Promise<void>;
  getStatus(identity: McpServerIdentity): McpRuntimeStatus;
}

/** Process-wide registry of active MCP Runtime handles. */
export interface McpRuntimeRegistry {
  register(handle: ActiveMcpRuntimeHandle): () => void;
  /** Monotonic per-identity generation shared with the coordinator. */
  currentGeneration(identity: McpServerIdentity): number;
  /** Monotonic per-server-name generation for global configuration reconciliation. */
  currentNamedGeneration(name: string): number;
}

/**
 * Coordinator used when no active Runtime registry is wired in (CLI without a
 * running daemon, embedded hosts). It never starts a daemon and never fails a
 * credential operation; it simply reports that Runtime state is unavailable.
 */
export function createUnavailableMcpRuntimeCoordinator(): McpRuntimeConnectionCoordinator {
  const unavailable = (): Promise<McpRuntimeSyncResult> =>
    Promise.resolve({ status: "unavailable", affectedRuntimes: 0, failures: [] });
  return {
    getStatus: unavailable,
    synchronize: unavailable,
    reconcileGlobal: unavailable,
  };
}

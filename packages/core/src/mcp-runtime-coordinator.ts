import type {
  McpRuntimeConnectionCoordinator,
  McpRuntimeSyncResult,
} from "./types/mcp-oauth";

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

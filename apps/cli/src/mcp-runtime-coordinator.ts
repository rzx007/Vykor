import {
  IncompatibleProtocolError,
  VykorApiError,
  VykorClient,
} from "@vykor/client";
import type {
  McpRuntimeConnectionCoordinator,
  McpRuntimeSyncResult,
  McpServerIdentity,
} from "@vykor/core";
import { readDaemonRegistry } from "@vykor/server";

export interface CliMcpRuntimeClient {
  mcp: {
    runtimeStatus(name: string, fingerprint: string): Promise<McpRuntimeSyncResult>;
    synchronize(name: string, fingerprint: string): Promise<McpRuntimeSyncResult>;
    reconcileGlobal(name: string): Promise<McpRuntimeSyncResult>;
  };
}

export interface CliMcpRuntimeCoordinatorOptions {
  readRegistry?(): { url: string; token: string } | undefined;
  createClient?(options: { baseUrl: string; token: string }): CliMcpRuntimeClient;
}

const unavailable = (): McpRuntimeSyncResult => ({
  status: "unavailable",
  affectedRuntimes: 0,
  failures: [],
});

/**
 * CLI-side Runtime coordinator.
 *
 * It reuses the daemon registry and the typed `@vykor/client` resource.
 * A missing registry or an unreachable daemon is reported as `unavailable`;
 * daemon authentication, protocol and server errors are surfaced as real sync
 * failures so they are never mistaken for an offline daemon.
 */
export function createCliMcpRuntimeCoordinator(
  options: CliMcpRuntimeCoordinatorOptions = {},
): McpRuntimeConnectionCoordinator {
  const readRegistry = options.readRegistry ?? (() => readDaemonRegistry());
  const createClient =
    options.createClient ?? ((clientOptions) => new VykorClient(clientOptions));

  const invoke = async (
    identity: McpServerIdentity,
    kind: "status" | "synchronize",
  ): Promise<McpRuntimeSyncResult> => {
    let registry: { url: string; token: string } | undefined;
    try {
      registry = readRegistry();
    } catch {
      registry = undefined;
    }
    if (!registry) return unavailable();

    const client = createClient({ baseUrl: registry.url, token: registry.token });
    try {
      return kind === "status"
        ? await client.mcp.runtimeStatus(identity.name, identity.endpointFingerprint)
        : await client.mcp.synchronize(identity.name, identity.endpointFingerprint);
    } catch (error) {
      if (isDaemonUnreachable(error)) return unavailable();
      throw error;
    }
  };

  return {
    getStatus: (identity) => invoke(identity, "status"),
    synchronize: (identity) => invoke(identity, "synchronize"),
    reconcileGlobal: async (name) => {
      let registry: { url: string; token: string } | undefined;
      try {
        registry = readRegistry();
      } catch {
        registry = undefined;
      }
      if (!registry) return unavailable();
      const client = createClient({ baseUrl: registry.url, token: registry.token });
      try {
        return await client.mcp.reconcileGlobal(name);
      } catch (error) {
        if (isDaemonUnreachable(error)) return unavailable();
        throw error;
      }
    },
  };
}

function isDaemonUnreachable(error: unknown): boolean {
  if (error instanceof VykorApiError || error instanceof IncompatibleProtocolError) {
    return false;
  }
  if (error instanceof TypeError && /fetch failed/i.test(error.message)) return true;
  if (error instanceof Error && error.name === "AbortError") return true;
  const code = collectErrorCode(error);
  return code !== undefined && DAEMON_UNREACHABLE_CODES.has(code);
}

const DAEMON_UNREACHABLE_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ETIMEDOUT",
  "UND_ERR_SOCKET",
]);

function collectErrorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

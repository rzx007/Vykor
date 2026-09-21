import {
  IncompatibleProtocolError,
  OpenHarnessApiError,
  OpenHarnessClient,
  type McpRuntimeSyncResult,
} from "@openharness/client"
import { readDaemonRegistry } from "@openharness/server"

interface McpRuntimeIdentity {
  name: string
  transport: "http"
  endpoint: string
  endpointFingerprint: string
}

interface DesktopMcpRuntimeClient {
  mcp: {
    runtimeStatus(name: string, fingerprint: string): Promise<McpRuntimeSyncResult>
    synchronize(name: string, fingerprint: string): Promise<McpRuntimeSyncResult>
  }
}

export interface DesktopMcpRuntimeCoordinatorOptions {
  readRegistry?(): { url: string; token: string } | undefined
  createClient?(options: { baseUrl: string; token: string }): DesktopMcpRuntimeClient
}

const unavailable = (): McpRuntimeSyncResult => ({
  status: "unavailable",
  affectedRuntimes: 0,
  failures: [],
})

/**
 * Desktop-side MCP Runtime coordinator.
 *
 * It calls the same daemon control plane through `@openharness/client` and the
 * daemon registry the main process already owns. A missing registry or an
 * unreachable daemon is `unavailable`; daemon auth, protocol and server errors
 * stay real sync failures so the page can show "saved, but reconnect failed".
 */
export function createDesktopMcpRuntimeCoordinator(
  options: DesktopMcpRuntimeCoordinatorOptions = {}
): {
  getStatus(identity: McpRuntimeIdentity): Promise<McpRuntimeSyncResult>
  synchronize(identity: McpRuntimeIdentity): Promise<McpRuntimeSyncResult>
} {
  const readRegistry = options.readRegistry ?? (() => readDaemonRegistry())
  const createClient =
    options.createClient ?? ((clientOptions) => new OpenHarnessClient(clientOptions))

  const invoke = async (
    identity: McpRuntimeIdentity,
    kind: "status" | "synchronize"
  ): Promise<McpRuntimeSyncResult> => {
    let registry: { url: string; token: string } | undefined
    try {
      registry = readRegistry()
    } catch {
      registry = undefined
    }
    if (!registry) return unavailable()

    const client = createClient({ baseUrl: registry.url, token: registry.token })
    try {
      return kind === "status"
        ? await client.mcp.runtimeStatus(identity.name, identity.endpointFingerprint)
        : await client.mcp.synchronize(identity.name, identity.endpointFingerprint)
    } catch (error) {
      if (isDaemonUnreachable(error)) return unavailable()
      throw error
    }
  }

  return {
    getStatus: (identity) => invoke(identity, "status"),
    synchronize: (identity) => invoke(identity, "synchronize"),
  }
}

function isDaemonUnreachable(error: unknown): boolean {
  if (error instanceof OpenHarnessApiError || error instanceof IncompatibleProtocolError) {
    return false
  }
  if (error instanceof TypeError && /fetch failed/i.test(error.message)) return true
  if (error instanceof Error && error.name === "AbortError") return true
  const code = collectErrorCode(error)
  return code !== undefined && DAEMON_UNREACHABLE_CODES.has(code)
}

const DAEMON_UNREACHABLE_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ETIMEDOUT",
  "UND_ERR_SOCKET",
])

function collectErrorCode(error: unknown): string | undefined {
  let current: unknown = error
  for (let depth = 0; depth < 5 && current; depth += 1) {
    const code = (current as { code?: unknown }).code
    if (typeof code === "string") return code
    current = (current as { cause?: unknown }).cause
  }
  return undefined
}

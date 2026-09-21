import type { McpRuntimeSyncResult } from "../types/index.js";
import type { HttpTransport } from "../transport/http-transport.js";

/**
 * Read-only MCP Runtime control resource.
 *
 * Only the server name and endpoint fingerprint cross the wire; the client
 * never sends a full endpoint, token or login/logout intent.
 */
export class McpResource {
  constructor(private readonly transport: HttpTransport) {}

  async runtimeStatus(
    name: string,
    fingerprint: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<McpRuntimeSyncResult> {
    return await this.transport.request<McpRuntimeSyncResult>(
      this.transport.path(
        `/mcp/${encodeURIComponent(name)}/runtime-status`,
        { fingerprint },
      ),
      { signal: options.signal },
    );
  }

  async synchronize(
    name: string,
    fingerprint: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<McpRuntimeSyncResult> {
    return await this.transport.request<McpRuntimeSyncResult>(
      `/mcp/${encodeURIComponent(name)}/synchronize`,
      { method: "POST", body: { fingerprint }, signal: options.signal },
    );
  }
}

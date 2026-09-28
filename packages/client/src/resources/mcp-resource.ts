import {
  parseOAuthOperationEvent,
  type McpOAuthLoginInput,
  type McpOAuthLoginResponse,
  type McpOAuthStatusSnapshot,
  type OAuthOperationEvent,
  type OAuthOperationView,
} from "@vykor/protocol";
import type { McpRuntimeSyncResult } from "../types/index.js";
import type { HttpTransport } from "../transport/http-transport.js";
import { streamServerSentEvents } from "../transport/sse-transport.js";

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

  /**
   * Ask every active Runtime to re-check the latest global config for `name`.
   * Only the server name crosses the wire.
   */
  async reconcileGlobal(
    name: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<McpRuntimeSyncResult> {
    return await this.transport.request<McpRuntimeSyncResult>(
      `/mcp/${encodeURIComponent(name)}/reconcile-global`,
      { method: "POST", body: {}, signal: options.signal },
    );
  }

  // --- MCP OAuth login operations -----------------------------------------

  async authStatus(options: { signal?: AbortSignal } = {}): Promise<McpOAuthStatusSnapshot> {
    return await this.transport.request<McpOAuthStatusSnapshot>("/mcp/oauth/status", { signal: options.signal });
  }

  async startLogin(
    name: string,
    input: McpOAuthLoginInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<McpOAuthLoginResponse> {
    return await this.transport.request<McpOAuthLoginResponse>(
      `/mcp/${encodeURIComponent(name)}/oauth/login`,
      { method: "POST", body: input, signal: options.signal },
    );
  }

  async getLogin(loginId: string, options: { signal?: AbortSignal } = {}): Promise<OAuthOperationView> {
    return await this.transport.request<OAuthOperationView>(
      `/mcp/oauth/operations/${encodeURIComponent(loginId)}`,
      { signal: options.signal },
    );
  }

  async submitCallback(
    loginId: string,
    callbackUrl: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<OAuthOperationView> {
    return await this.transport.request<OAuthOperationView>(
      `/mcp/oauth/operations/${encodeURIComponent(loginId)}/callback`,
      { method: "POST", body: { callbackUrl }, signal: options.signal },
    );
  }

  async cancelLogin(loginId: string, options: { signal?: AbortSignal } = {}): Promise<OAuthOperationView> {
    return await this.transport.request<OAuthOperationView>(
      `/mcp/oauth/operations/${encodeURIComponent(loginId)}`,
      { method: "DELETE", signal: options.signal },
    );
  }

  async logout(name: string, options: { signal?: AbortSignal } = {}): Promise<McpOAuthStatusSnapshot> {
    return await this.transport.request<McpOAuthStatusSnapshot>(
      `/mcp/${encodeURIComponent(name)}/oauth/logout`,
      { method: "POST", body: {}, signal: options.signal },
    );
  }

  async *watchLogin(
    loginId: string,
    options: { signal?: AbortSignal } = {},
  ): AsyncIterable<OAuthOperationEvent> {
    const response = await this.transport.requestResponse(
      `/mcp/oauth/operations/${encodeURIComponent(loginId)}/events`,
      { signal: options.signal },
    );
    if (!response.body) return;
    try {
      yield* streamServerSentEvents<OAuthOperationEvent>(async () => response.body!, parseOAuthOperationEvent);
    } finally {
      await response.body.cancel().catch(() => undefined);
    }
  }
}

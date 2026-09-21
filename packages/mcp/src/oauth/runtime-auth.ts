import type {
  McpOAuthCredentialRecord,
  McpRemoteServerConfig,
  McpServerConfig,
} from "@openharness/core";
import { refreshAuthorization } from "@modelcontextprotocol/sdk/client/auth.js";
import { McpOAuthError } from "./errors.js";
import type { McpOAuthCredentialStore } from "./login.js";
import { timedFetch, tokenScopes } from "./protocol.js";
import { assertScopeSubset } from "./security.js";
import { resolveMcpAuthMode, resolveMcpOAuthStatus } from "./status.js";

export type McpConnectionAction = "connect" | "disconnect" | "ignore";

export class McpOAuthRuntime {
  private readonly inFlight = new Map<string, Promise<string | undefined>>();
  private readonly fetchImpl: typeof fetch;
  private readonly clock: () => number;

  constructor(private readonly options: {
    store: McpOAuthCredentialStore;
    fetch?: typeof fetch;
    allowLoopbackHttp?: boolean;
    clock?: () => number;
  }) {
    this.fetchImpl = options.fetch ?? fetch;
    this.clock = options.clock ?? (() => Date.now());
  }

  async getStatus(name: string, config: McpServerConfig) {
    return resolveMcpOAuthStatus(config, await this.options.store.get(name), this.clock());
  }

  /** Read the final credential state before a Runtime sync; static auth is unaffected. */
  async getConnectionAction(name: string, config: McpServerConfig): Promise<McpConnectionAction> {
    if (config.type !== "http") return "ignore";
    const staticMode = resolveMcpAuthMode(config, undefined);
    if (staticMode === "bearer" || staticMode === "custom") return "ignore";
    const credential = await this.options.store.get(name);
    const status = resolveMcpOAuthStatus(config, credential, this.clock());
    return (status === "valid" || status === "expired-refreshable") && credential?.serverUrl === config.url
      ? "connect"
      : "disconnect";
  }

  async getAccessToken(
    name: string,
    config: McpRemoteServerConfig,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    const credential = await this.options.store.get(name);
    if (!credential) return undefined;
    if (credential.diagnostic?.code === "reauthentication-required") {
      throw new McpOAuthError("oauth-reauthentication-required", "MCP OAuth login is required");
    }
    if (
      credential.registration.client_secret_expires_at &&
      credential.registration.client_secret_expires_at * 1000 <= this.clock()
    ) {
      await this.markReauthentication(name);
      throw new McpOAuthError("oauth-reauthentication-required", "OAuth client registration expired");
    }
    if (credential.serverUrl !== config.url) {
      await this.markReauthentication(name);
      throw new McpOAuthError("oauth-binding-changed", "OAuth credential is bound to another MCP endpoint");
    }
    if (!credential.tokens.expiresAt || credential.tokens.expiresAt - this.clock() > 30_000) {
      return credential.tokens.accessToken || undefined;
    }
    return this.refreshOnce(name, config, credential, signal);
  }

  createFetch(name: string, config: McpRemoteServerConfig): typeof fetch {
    return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const original = new Request(input as any, init as any);
      const token = await this.getAccessToken(name, config, init?.signal ?? undefined);
      const first = withBearer(original.clone(), token);
      const response = await this.fetchImpl(first);
      if (isInsufficientScope(response)) {
        throw new McpOAuthError("oauth-scope-expansion-required", "MCP server requires additional OAuth scopes");
      }
      if (response.status !== 401) return response;
      const credential = await this.options.store.get(name);
      if (!credential?.tokens.refreshToken) {
        await this.markReauthentication(name);
        throw new McpOAuthError("oauth-reauthentication-required", "MCP OAuth login is required");
      }
      const refreshed = await this.refreshOnce(name, config, credential, init?.signal ?? undefined, true);
      const retried = await this.fetchImpl(withBearer(original.clone(), refreshed));
      if (retried.status === 401) {
        await this.markReauthentication(name);
        throw new McpOAuthError("oauth-reauthentication-required", "MCP OAuth token was rejected after refresh");
      }
      if (isInsufficientScope(retried)) {
        throw new McpOAuthError("oauth-scope-expansion-required", "MCP server requires additional OAuth scopes");
      }
      return retried;
    }) as typeof fetch;
  }

  private refreshOnce(
    name: string,
    config: McpRemoteServerConfig,
    before: McpOAuthCredentialRecord,
    signal?: AbortSignal,
    force = false,
  ): Promise<string | undefined> {
    const active = this.inFlight.get(name);
    if (active) return active;
    const refresh = this.refreshLocked(name, config, before, signal, force)
      .finally(() => this.inFlight.delete(name));
    this.inFlight.set(name, refresh);
    return refresh;
  }

  private async refreshLocked(
    name: string,
    config: McpRemoteServerConfig,
    before: McpOAuthCredentialRecord,
    signal?: AbortSignal,
    force = false,
  ): Promise<string | undefined> {
    try {
      return await this.options.store.runExclusive(name, async current => {
        if (!current) throw new McpOAuthError("oauth-credential-removed", "OAuth credential was removed");
        if (current.serverUrl !== config.url || current.binding.issuer !== before.binding.issuer || current.binding.redirectUri !== before.binding.redirectUri) {
          throw new McpOAuthError("oauth-binding-changed", "OAuth credential binding changed");
        }
        const tokenChanged = current.tokens.accessToken !== before.tokens.accessToken || current.tokens.refreshToken !== before.tokens.refreshToken;
        const currentFresh = !current.tokens.expiresAt || current.tokens.expiresAt - this.clock() > 30_000;
        if (tokenChanged && currentFresh) return { next: current, result: current.tokens.accessToken };
        if (!force && currentFresh) return { next: current, result: current.tokens.accessToken };
        if (!current.tokens.refreshToken) throw new McpOAuthError("oauth-reauthentication-required", "OAuth refresh token is unavailable");
        const response = await refreshAuthorization(current.binding.issuer, {
          metadata: {
            issuer: current.binding.issuer,
            authorization_endpoint: current.binding.authorizationEndpoint,
            token_endpoint: current.binding.tokenEndpoint,
            registration_endpoint: current.binding.registrationEndpoint,
            revocation_endpoint: current.binding.revocationEndpoint,
          } as any,
          clientInformation: current.registration as any,
          refreshToken: current.tokens.refreshToken,
          resource: new URL(config.url),
          fetchFn: ((request: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
            timedFetch(this.fetchImpl, request as any, { ...(init as RequestInit), signal: signal ?? init?.signal })) as any,
        }).catch(error => {
          const invalidGrant = error instanceof Error && /invalid_grant/i.test(error.message);
          throw new McpOAuthError(
            invalidGrant ? "oauth-invalid-grant" : "oauth-refresh-failed",
            invalidGrant ? "OAuth refresh token is no longer valid" : "OAuth token refresh failed",
          );
        });
        const scopes = tokenScopes(response, current.tokens.scope);
        assertScopeSubset(scopes, current.tokens.scope);
        const next: McpOAuthCredentialRecord = {
          ...current,
          tokens: {
            accessToken: response.access_token,
            refreshToken: response.refresh_token ?? current.tokens.refreshToken,
            tokenType: response.token_type ?? current.tokens.tokenType,
            scope: scopes,
            expiresAt: response.expires_in ? this.clock() + response.expires_in * 1000 : undefined,
          },
          diagnostic: undefined,
        };
        return { next, result: next.tokens.accessToken };
      });
    } catch (error) {
      await this.markReauthentication(name);
      throw error;
    }
  }

  private async markReauthentication(name: string): Promise<void> {
    await this.options.store.update(name, current => current ? {
      ...current,
      diagnostic: { code: "reauthentication-required", updatedAt: this.clock() },
    } : current).catch(() => undefined);
  }
}

function withBearer(request: any, token: string | undefined): any {
  if (!token) return request;
  const headers = new Headers(request.headers);
  headers.set("authorization", `Bearer ${token}`);
  return new Request(request, { headers });
}

function isInsufficientScope(response: Response): boolean {
  return response.status === 403 && /(?:error\s*=\s*"?insufficient_scope|insufficient_scope)/i.test(response.headers.get("www-authenticate") ?? "");
}

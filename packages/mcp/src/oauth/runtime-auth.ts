import type {
  McpOAuthCredentialRecord,
  McpOAuthSettings,
  McpRemoteServerConfig,
  McpServerConfig,
} from "@vykor/core";
import { refreshAuthorization } from "@modelcontextprotocol/sdk/client/auth.js";
import { McpOAuthError } from "./errors.js";
import type { McpOAuthCredentialStore } from "./login.js";
import { timedFetch, tokenScopes } from "./protocol.js";
import { credentialBindingMatches } from "./resource-binding.js";
import { assertScopeSubset } from "./security.js";
import { oauthScopesChanged, resolveMcpAuthMode, resolveMcpOAuthStatus } from "./status.js";

export type McpConnectionAction = "connect" | "disconnect" | "ignore";

/** Internal result of resolving a token; `used` is the credential whose token was returned. */
interface AccessTokenOutcome {
  token: string | undefined;
  used: McpOAuthCredentialRecord;
}

/** Failure disposition for one refresh attempt: the error to surface and whether to invalidate. */
interface RefreshDisposition {
  error: unknown;
  mark: boolean;
}

const CONFIG_ERROR_CODES = new Set([
  "invalid_client",
  "unauthorized_client",
  "unsupported_grant_type",
  "invalid_client_metadata",
]);

export class McpOAuthRuntime {
  private readonly inFlight = new Map<string, Promise<AccessTokenOutcome>>();
  private readonly fetchImpl: typeof fetch;
  private readonly clock: () => number;

  constructor(private readonly options: {
    store: McpOAuthCredentialStore;
    fetch?: typeof fetch;
    allowLoopbackHttp?: boolean;
    clock?: () => number;
    getConfiguredOAuth?: (name: string, config: McpRemoteServerConfig) => Promise<McpOAuthSettings | undefined>;
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
    if (!credential) return "disconnect";
    const oauth = await this.configuredOAuth(name, config);
    const status = resolveMcpOAuthStatus({ ...config, oauth }, credential, this.clock());
    return (status === "valid" || status === "expired-refreshable")
      ? "connect"
      : "disconnect";
  }

  async getAccessToken(
    name: string,
    config: McpRemoteServerConfig,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    return (await this.resolveAccessToken(name, config, signal))?.token;
  }

  private async resolveAccessToken(
    name: string,
    config: McpRemoteServerConfig,
    signal?: AbortSignal,
  ): Promise<AccessTokenOutcome | undefined> {
    const credential = await this.options.store.get(name);
    if (!credential) return undefined;
    if (credential.diagnostic?.code === "reauthentication-required") {
      throw new McpOAuthError("oauth-reauthentication-required", "MCP OAuth login is required");
    }
    if (
      credential.registration.client_secret_expires_at &&
      credential.registration.client_secret_expires_at * 1000 <= this.clock()
    ) {
      await this.markReauthentication(name, credential);
      throw new McpOAuthError("oauth-reauthentication-required", "OAuth client registration expired");
    }
    const oauth = await this.configuredOAuth(name, config);
    if (!credentialBindingMatches({ ...config, oauth }, credential)) {
      // A moved endpoint or audience is a configuration change; the old
      // record must not be cross-marked as an invalid credential.
      throw new McpOAuthError("oauth-binding-changed", "OAuth credential is bound to another MCP endpoint or resource");
    }
    if (oauthScopesChanged(oauth?.scopes, credential.tokens.scope)) {
      throw new McpOAuthError("oauth-reauthentication-required", `MCP OAuth scopes changed; run vk mcp login ${name} --scopes with the configured scopes`);
    }
    if (!credential.tokens.expiresAt || credential.tokens.expiresAt - this.clock() > 30_000) {
      return { token: credential.tokens.accessToken || undefined, used: credential };
    }
    return this.refreshOnce(name, config, credential, signal);
  }

  private async configuredOAuth(name: string, config: McpRemoteServerConfig): Promise<McpOAuthSettings | undefined> {
    return this.options.getConfiguredOAuth
      ? await this.options.getConfiguredOAuth(name, config)
      : config.oauth;
  }

  createFetch(name: string, config: McpRemoteServerConfig): typeof fetch {
    return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const original = new Request(input as any, { ...init, redirect: "error" } as any);
      const resolved = await this.resolveAccessToken(name, config, original.signal);
      const first = withBearer(original.clone(), resolved?.token);
      const response = await this.fetchImpl(first);
      if (isInsufficientScope(response)) {
        throw new McpOAuthError("oauth-scope-expansion-required", "MCP server requires additional OAuth scopes");
      }
      if (response.status !== 401) return response;
      const credential = resolved?.used;
      if (!credential?.tokens.refreshToken) {
        await this.markReauthentication(name, credential);
        throw new McpOAuthError("oauth-reauthentication-required", "MCP OAuth login is required");
      }
      const refreshed = await this.refreshOnce(name, config, credential, original.signal, true);
      const retried = await this.fetchImpl(withBearer(original.clone(), refreshed.token));
      if (retried.status === 401) {
        await this.markReauthentication(name, refreshed.used);
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
  ): Promise<AccessTokenOutcome> {
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
  ): Promise<AccessTokenOutcome> {
    let used: McpOAuthCredentialRecord | undefined = before;
    try {
      return await this.options.store.runExclusive(name, async (current, context) => {
        if (!current) throw new McpOAuthError("oauth-credential-removed", "OAuth credential was removed");
        used = current;
        if (
          current.serverUrl !== config.url ||
          current.binding.issuer !== before.binding.issuer ||
          current.binding.redirectUri !== before.binding.redirectUri ||
          current.binding.resourceUrl !== before.binding.resourceUrl
        ) {
          throw new McpOAuthError("oauth-binding-changed", "OAuth credential binding changed");
        }
        const tokenChanged = current.tokens.accessToken !== before.tokens.accessToken || current.tokens.refreshToken !== before.tokens.refreshToken;
        const currentFresh = !current.tokens.expiresAt || current.tokens.expiresAt - this.clock() > 30_000;
        if ((tokenChanged && currentFresh) || (!force && currentFresh)) {
          return { next: current, result: { token: current.tokens.accessToken || undefined, used: current } };
        }
        if (!current.tokens.refreshToken) throw new McpOAuthError("oauth-reauthentication-required", "OAuth refresh token is unavailable");
        const response = await this.requestRefresh(config, current, signal);
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
        used = { ...next, revision: context.nextRevision };
        return { next, result: { token: next.tokens.accessToken || undefined, used } };
      });
    } catch (error) {
      const disposition = classifyRefreshError(error, signal);
      if (disposition.mark && used) {
        await this.markReauthentication(name, used).catch(() => undefined);
      }
      throw disposition.error;
    }
  }

  /**
   * Call the SDK refresh with a fetch wrapper that records only the safe HTTP
   * status of a failed token request. Response bodies, tokens and full URLs are
   * never retained here.
   */
  private async requestRefresh(
    config: McpRemoteServerConfig,
    current: McpOAuthCredentialRecord,
    signal?: AbortSignal,
  ): Promise<Awaited<ReturnType<typeof refreshAuthorization>>> {
    let failedStatus: number | undefined;
    const fetchFn = ((request: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
      timedFetch(this.fetchImpl, request as any, { ...(init as RequestInit), signal: signal ?? init?.signal }).then((response) => {
        if (!response.ok) failedStatus = response.status;
        return response;
      })) as typeof fetch;
    try {
      return await refreshAuthorization(current.binding.issuer, {
        metadata: {
          issuer: current.binding.issuer,
          authorization_endpoint: current.binding.authorizationEndpoint,
          token_endpoint: current.binding.tokenEndpoint,
          registration_endpoint: current.binding.registrationEndpoint,
          revocation_endpoint: current.binding.revocationEndpoint,
        } as any,
        clientInformation: current.registration as any,
        refreshToken: current.tokens.refreshToken!,
        resource: new URL(current.binding.resourceUrl ?? config.url),
        fetchFn: fetchFn as any,
      });
    } catch (error) {
      throw annotateHttpStatus(error, failedStatus);
    }
  }

  private async markReauthentication(name: string, used?: McpOAuthCredentialRecord): Promise<void> {
    if (!used) return;
    await this.options.store.update(name, current => {
      if (!current) return current;
      // CAS: only invalidate the exact version that was actually used. If a
      // concurrent login/logout replaced it, leave the newer state alone.
      if (used && !sameCredentialVersion(used, current)) return current;
      if (current.diagnostic?.code === "reauthentication-required") return current;
      return {
        ...current,
        diagnostic: { code: "reauthentication-required", updatedAt: this.clock() },
      };
    }).catch(() => undefined);
  }
}

/** Preserve the structured SDK `errorCode`; never read `error.message`. */
function oauthErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = (error as { errorCode?: unknown }).errorCode;
  return typeof value === "string" ? value : undefined;
}

function annotateHttpStatus(error: unknown, status: number | undefined): unknown {
  if (status === undefined || error instanceof McpOAuthError) return error;
  if (error && typeof error === "object") {
    try {
      Object.defineProperty(error, "httpStatus", { value: status, enumerable: false, configurable: true });
    } catch {
      // Frozen errors keep their original shape.
    }
  }
  return error;
}

function classifyRefreshError(error: unknown, signal?: AbortSignal): RefreshDisposition {
  // User cancellation keeps the record untouched and is never retried here.
  if (signal?.aborted) return { error, mark: false };
  // Storage failures are not permanent credential failures.
  if (error instanceof Error && error.name === "McpOAuthStoreError") return { error, mark: false };
  if (error instanceof McpOAuthError) {
    if (error.code === "oauth-reauthentication-required" || error.code === "oauth-invalid-grant") {
      return { error: new McpOAuthError("oauth-reauthentication-required", "MCP OAuth login is required"), mark: true };
    }
    return { error, mark: false };
  }
  const code = oauthErrorCode(error);
  const status = error && typeof error === "object" ? (error as { httpStatus?: unknown }).httpStatus : undefined;
  if (status === 429 || (typeof status === "number" && status >= 500)) {
    return { error: new McpOAuthError("oauth-refresh-failed", `OAuth token refresh failed (HTTP ${status})`, true), mark: false };
  }
  if (code === "invalid_grant") {
    return { error: new McpOAuthError("oauth-reauthentication-required", "OAuth refresh token is no longer valid"), mark: true };
  }
  if (code && CONFIG_ERROR_CODES.has(code)) {
    return {
      error: new McpOAuthError("oauth-client-config-error", "OAuth client configuration was rejected; check the client ID or re-register"),
      mark: false,
    };
  }
  if (code === "invalid_target") {
    return { error: new McpOAuthError("oauth-resource-mismatch", "OAuth resource binding was rejected"), mark: false };
  }
  if (code === "invalid_scope") {
    return { error: new McpOAuthError("oauth-scope-expansion", "OAuth scope was rejected"), mark: false };
  }
  const suffix = typeof status === "number" ? ` (HTTP ${status})` : "";
  // Network failures, timeouts, 429 and 5xx are retryable and keep the record.
  return { error: new McpOAuthError("oauth-refresh-failed", `OAuth token refresh failed${suffix}`, true), mark: false };
}

function sameCredentialVersion(a: McpOAuthCredentialRecord, b: McpOAuthCredentialRecord): boolean {
  return a.revision === b.revision &&
    a.serverUrl === b.serverUrl &&
    a.binding.issuer === b.binding.issuer &&
    a.binding.resourceUrl === b.binding.resourceUrl &&
    a.tokens.accessToken === b.tokens.accessToken &&
    a.tokens.refreshToken === b.tokens.refreshToken;
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

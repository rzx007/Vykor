import { randomBytes } from "node:crypto";
import {
  exchangeAuthorization,
  registerClient,
  startAuthorization,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type { McpOAuthCredentialRecord, McpRemoteServerConfig } from "@openharness/core";
import { createOAuthCallback, type OAuthCallbackController } from "./callback.js";
import { McpOAuthError } from "./errors.js";
import {
  discoverOAuth,
  revokeToken,
  timedFetch,
  tokenScopes,
  type OAuthAuthorizationServerMetadata,
} from "./protocol.js";
import { assertScopeSubset, uniqueScopes } from "./security.js";

export interface McpOAuthCredentialStore {
  get(name: string): Promise<McpOAuthCredentialRecord | undefined>;
  set(name: string, credential: McpOAuthCredentialRecord): Promise<void>;
  delete(name: string): Promise<boolean>;
  update(name: string, mutate: (current: McpOAuthCredentialRecord | undefined) => McpOAuthCredentialRecord | undefined): Promise<McpOAuthCredentialRecord | undefined>;
  runExclusive<T>(name: string, operation: (current: McpOAuthCredentialRecord | undefined) => Promise<{ next: McpOAuthCredentialRecord | undefined; result: T }>): Promise<T>;
}

export interface McpOAuthLoginDeps {
  fetch?: typeof fetch;
  callbackFactory?: typeof createOAuthCallback;
  openBrowser?(url: string): Promise<void>;
  readCallbackUrl?(prompt: string): Promise<string>;
  verifyConnection?(input: { serverName: string; config: McpRemoteServerConfig }): Promise<void>;
  stdout?(line: string): void;
}

export interface McpOAuthLoginInput {
  serverName: string;
  config: McpRemoteServerConfig;
  scopes?: string[];
  noBrowser?: boolean;
  store: McpOAuthCredentialStore;
  allowLoopbackHttp?: boolean;
  signal?: AbortSignal;
}

export async function loginMcpOAuth(
  input: McpOAuthLoginInput,
  deps: McpOAuthLoginDeps = {},
): Promise<{ status: "valid"; scopes: string[]; verified: boolean }> {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new McpOAuthError("oauth-login-timeout", "OAuth login timed out")), 300_000);
  timer.unref?.();
  const signal = input.signal ? AbortSignal.any([input.signal, deadline.signal]) : deadline.signal;
  try {
    return await performLogin({ ...input, signal }, deps);
  } finally {
    clearTimeout(timer);
  }
}

async function performLogin(
  input: McpOAuthLoginInput,
  deps: McpOAuthLoginDeps,
): Promise<{ status: "valid"; scopes: string[]; verified: boolean }> {
  if (input.config.type !== "http") throw new McpOAuthError("oauth-transport-unsupported", "OAuth is supported only for Streamable HTTP MCP servers");
  if (hasAuthorizationHeader(input.config.headers)) {
    throw new McpOAuthError("oauth-static-auth-conflict", "Remove the configured Authorization header before OAuth login");
  }
  const fetchImpl = deps.fetch ?? fetch;
  const discovered = await discoverOAuth(input.config.url, fetchImpl, {
    allowLoopbackHttp: input.allowLoopbackHttp,
    signal: input.signal,
  });
    const configured = uniqueScopes(input.scopes ?? input.config.oauth?.scopes ?? []);
    const advertised = uniqueScopes(discovered.resource.scopes_supported ?? discovered.authorization.scopes_supported ?? []);
    if (!configured.length && advertised.length) {
      throw new McpOAuthError("oauth-scopes-not-approved", `Choose scopes explicitly with --scopes. Available: ${advertised.join(", ")}`);
    }
    if (advertised.length) assertScopeSubset(configured, advertised);
    const state = randomBytes(32).toString("base64url");
    const liveCallback = await (deps.callbackFactory ?? createOAuthCallback)({
      expectedState: state,
      expectedIssuer: discovered.authorization.issuer,
      requireIssuer: discovered.authorization.authorization_response_iss_parameter_supported,
      port: input.config.oauth?.callbackPort,
      deadlineMs: 300_000,
    });
    try {
      const registration = await resolveRegistration(input.config, discovered.authorization, liveCallback.redirectUri, configured, fetchImpl, input.signal);
      const { authorizationUrl, codeVerifier } = await startAuthorization(discovered.authorization.issuer, {
        metadata: discovered.authorization as any,
        clientInformation: registration as any,
        redirectUrl: liveCallback.redirectUri,
        scope: configured.length ? configured.join(" ") : undefined,
        state,
        resource: new URL(input.config.url),
      });
      deps.stdout?.(`Open this URL to authorize:\n${authorizationUrl}`);
      if (!input.noBrowser && deps.openBrowser) {
        await deps.openBrowser(authorizationUrl.toString()).catch(() => undefined);
      }
      let callbackResult: Awaited<ReturnType<OAuthCallbackController["wait"]>>;
      if (input.noBrowser && deps.readCallbackUrl) {
        callbackResult = await Promise.race([
          liveCallback.wait(input.signal),
          deps.readCallbackUrl("Paste the full callback URL: ").then(value => liveCallback.accept(new URL(value.trim()))),
        ]);
      } else {
        callbackResult = await liveCallback.wait(input.signal);
      }
      const tokenResponse = await exchangeAuthorization(discovered.authorization.issuer, {
          metadata: discovered.authorization as any,
          clientInformation: registration as any,
          authorizationCode: callbackResult.code,
          codeVerifier,
          redirectUri: liveCallback.redirectUri,
          resource: new URL(input.config.url),
          fetchFn: sdkFetch(fetchImpl, input.signal) as any,
        }).catch(() => {
          throw new McpOAuthError("oauth-token-failed", "OAuth token exchange failed");
        });
      const scopes = tokenScopes(tokenResponse, configured);
      try {
        assertScopeSubset(scopes, configured);
      } catch (error) {
        if (discovered.authorization.revocation_endpoint) {
          if (tokenResponse.refresh_token) {
            await revokeToken({ endpoint: discovered.authorization.revocation_endpoint, token: tokenResponse.refresh_token, hint: "refresh_token", registration, fetch: fetchImpl, signal: input.signal }).catch(() => undefined);
          }
          await revokeToken({ endpoint: discovered.authorization.revocation_endpoint, token: tokenResponse.access_token, hint: "access_token", registration, fetch: fetchImpl, signal: input.signal }).catch(() => undefined);
        }
        throw error;
      }
      const credential: McpOAuthCredentialRecord = {
        serverUrl: input.config.url,
        revision: 0,
        binding: {
          issuer: discovered.authorization.issuer,
          redirectUri: liveCallback.redirectUri,
          authorizationEndpoint: discovered.authorization.authorization_endpoint,
          tokenEndpoint: discovered.authorization.token_endpoint,
          registrationEndpoint: discovered.authorization.registration_endpoint,
          revocationEndpoint: discovered.authorization.revocation_endpoint,
          authorizationResponseIssParameterSupported: discovered.authorization.authorization_response_iss_parameter_supported,
        },
        registration,
        tokens: {
          accessToken: tokenResponse.access_token,
          refreshToken: tokenResponse.refresh_token,
          tokenType: tokenResponse.token_type ?? "Bearer",
          scope: scopes,
          expiresAt: tokenResponse.expires_in ? Date.now() + tokenResponse.expires_in * 1000 : undefined,
        },
      };
      await input.store.set(input.serverName, credential);
      let verified = false;
      if (deps.verifyConnection) {
        try {
          await deps.verifyConnection({ serverName: input.serverName, config: input.config });
          verified = true;
        } catch (error) {
          if (isAuthenticationFailure(error)) {
            await input.store.update(input.serverName, current => current ? { ...current, diagnostic: { code: "reauthentication-required", updatedAt: Date.now() } } : current);
            throw error;
          }
        }
      }
      return { status: "valid", scopes, verified };
    } finally {
      await liveCallback.close();
    }
}

export async function revokeMcpOAuthCredential(input: {
  serverName: string;
  store: McpOAuthCredentialStore;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}): Promise<void> {
  const credential = await input.store.get(input.serverName);
  try {
    if (credential?.binding.revocationEndpoint) {
      if (credential.tokens.refreshToken) {
        await revokeToken({ endpoint: credential.binding.revocationEndpoint, token: credential.tokens.refreshToken, hint: "refresh_token", registration: credential.registration, fetch: input.fetch ?? fetch, signal: input.signal }).catch(() => undefined);
      }
      await revokeToken({ endpoint: credential.binding.revocationEndpoint, token: credential.tokens.accessToken, hint: "access_token", registration: credential.registration, fetch: input.fetch ?? fetch, signal: input.signal }).catch(() => undefined);
    }
  } finally {
    await input.store.delete(input.serverName);
  }
}

async function resolveRegistration(
  config: McpRemoteServerConfig,
  metadata: OAuthAuthorizationServerMetadata,
  redirectUri: string,
  scopes: string[],
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<McpOAuthCredentialRecord["registration"]> {
  if (config.oauth?.clientId) return { client_id: config.oauth.clientId, token_endpoint_auth_method: "none" };
  if (!metadata.registration_endpoint) throw new McpOAuthError("oauth-registration-unavailable", "OAuth server does not support dynamic client registration; configure clientId");
  const body = await registerClient(metadata.issuer, {
    metadata: metadata as any,
    clientMetadata: {
      client_name: "OpenHarness CLI",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
    scope: scopes.length ? scopes.join(" ") : undefined,
    fetchFn: sdkFetch(fetchImpl, signal) as any,
  }).catch(error => {
    void error;
    throw new McpOAuthError("oauth-registration-failed", "OAuth client registration failed");
  });
  return body as McpOAuthCredentialRecord["registration"];
}

function sdkFetch(fetchImpl: typeof fetch, signal?: AbortSignal): typeof fetch {
  return ((request: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    timedFetch(fetchImpl, request as any, { ...(init as RequestInit), signal: signal ?? init?.signal })) as typeof fetch;
}

function hasAuthorizationHeader(headers?: Record<string, string>): boolean {
  return Object.keys(headers ?? {}).some(key => key.toLowerCase() === "authorization");
}

function isAuthenticationFailure(error: unknown): boolean {
  return error instanceof McpOAuthError && /unauthorized|invalid-grant|reauthentication/.test(error.code);
}

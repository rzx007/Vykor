import { randomBytes } from "node:crypto";
import {
  exchangeAuthorization,
  registerClient,
  startAuthorization,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  CredentialMutationContext,
  McpOAuthCredentialRecord,
  McpRemoteServerConfig,
} from "@vykor/core";
import { createOAuthCallback, parseCallbackUrl, type OAuthCallbackController } from "./callback.js";
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
  runExclusive<T>(name: string, operation: (current: McpOAuthCredentialRecord | undefined, context: CredentialMutationContext) => Promise<{ next: McpOAuthCredentialRecord | undefined; result: T }>): Promise<T>;
  /** Atomically remove a record and return what was removed, advancing the logout epoch. */
  takeAndDelete(name: string): Promise<McpOAuthCredentialRecord | undefined>;
  /** Current logout counter; a completed commit must match the value captured at login start. */
  readLogoutEpoch(name: string): Promise<number>;
}

export interface McpOAuthLoginDeps {
  fetch?: typeof fetch;
  callbackFactory?: typeof createOAuthCallback;
  openBrowser?(url: string): Promise<void>;
  readCallbackUrl?(prompt: string, signal?: AbortSignal): Promise<string>;
  onCallbackAccepted?(): void;
  onCallbackRejected?(error: McpOAuthError): void;
  /**
   * Notified once when the authorization URL is ready. This is not a browser
   * open: a daemon only needs the URL to return to its client.
   */
  onAuthorizationUrl?(url: string): void | Promise<void>;
  /**
   * Verify the candidate credential against the real MCP server. The provided
   * store is an operation-local, writable copy: any refresh or token rotation
   * during verification stays in memory and is never written to the shared
   * credential store.
   */
  verifyConnection?(input: {
    serverName: string;
    config: McpRemoteServerConfig;
    store: McpOAuthCredentialStore;
    signal?: AbortSignal;
  }): Promise<void>;
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

export interface McpOAuthLoginResult {
  status: "valid";
  scopes: string[];
  verified: boolean;
  /** Final candidate credential; the caller decides whether to persist it. */
  credential: McpOAuthCredentialRecord;
}

export async function loginMcpOAuth(
  input: McpOAuthLoginInput,
  deps: McpOAuthLoginDeps = {},
): Promise<McpOAuthLoginResult> {
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
): Promise<McpOAuthLoginResult> {
  if (input.config.type !== "http") throw new McpOAuthError("oauth-transport-unsupported", "OAuth is supported only for Streamable HTTP MCP servers");
  if (hasAuthorizationHeader(input.config.headers)) {
    throw new McpOAuthError("oauth-static-auth-conflict", "Remove the configured Authorization header before OAuth login");
  }
  if (input.config.oauth?.callbackPort !== undefined && input.config.oauth?.callbackUrl !== undefined) {
    throw new McpOAuthError("oauth-callback-config-conflict", "Configure either oauth.callbackUrl or oauth.callbackPort, not both");
  }
  const configuredCallback = input.config.oauth?.callbackUrl
    ? parseCallbackUrl(input.config.oauth.callbackUrl)
    : undefined;
  const manual = configuredCallback?.manual === true || input.noBrowser === true;
  if (manual && !deps.readCallbackUrl) {
    throw new McpOAuthError("oauth-callback-unavailable", "A manual or HTTPS callback requires a way to submit the callback URL");
  }
  const fetchImpl = deps.fetch ?? fetch;
  const discovered = await discoverOAuth(input.config.url, fetchImpl, {
    allowLoopbackHttp: input.allowLoopbackHttp,
    signal: input.signal,
    resourceUrl: input.config.oauth?.resourceUrl,
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
      callbackUrl: input.config.oauth?.callbackUrl,
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
        resource: discovered.resourceUrl,
      });
      await deps.onAuthorizationUrl?.(authorizationUrl.toString());
      deps.stdout?.(`Open this URL to authorize:\n${authorizationUrl}`);
      if (!manual && deps.openBrowser) {
        await deps.openBrowser(authorizationUrl.toString()).catch(() => undefined);
      }
      let callbackResult: Awaited<ReturnType<OAuthCallbackController["wait"]>>;
      if (manual && deps.readCallbackUrl) {
        const reader = new AbortController();
        const readerSignal = input.signal ? AbortSignal.any([input.signal, reader.signal]) : reader.signal;
        const waiting = liveCallback.wait(input.signal);
        const submission = (async () => {
          while (true) {
            readerSignal.throwIfAborted();
            const value = await Promise.race([deps.readCallbackUrl!("Paste the full callback URL: ", readerSignal).then(value => ({ value })), waiting.then(result => ({ result }))]);
            if ("result" in value) return value.result;
            try {
              const result = await liveCallback.accept(new URL(value.value.trim()));
              deps.onCallbackAccepted?.();
              return result;
            } catch (error) {
              if (error instanceof McpOAuthError && error.code === "oauth-authorization-denied") {
                deps.onCallbackAccepted?.();
                throw error;
              }
              const safe = error instanceof McpOAuthError ? error : new McpOAuthError("oauth-callback-invalid", "OAuth callback URL is invalid");
              deps.onCallbackRejected?.(safe);
            }
          }
        })();
        try {
          callbackResult = await Promise.race([waiting, submission]);
        } finally {
          reader.abort(new DOMException("OAuth callback input is no longer needed", "AbortError"));
        }
      } else {
        callbackResult = await liveCallback.wait(input.signal);
      }
      const tokenResponse = await exchangeAuthorization(discovered.authorization.issuer, {
          metadata: discovered.authorization as any,
          clientInformation: registration as any,
          authorizationCode: callbackResult.code,
          codeVerifier,
          redirectUri: liveCallback.redirectUri,
          resource: discovered.resourceUrl,
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
          resourceUrl: discovered.resourceUrl.href,
          configuredResourceUrl: input.config.oauth?.resourceUrl ?? null,
          configuredCallbackUrl: input.config.oauth?.callbackUrl ?? null,
          configuredCallbackPort: input.config.oauth?.callbackPort ?? null,
          configuredClientId: input.config.oauth?.clientId ?? null,
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

      // The candidate lives only in this operation's memory. Active Runtimes
      // keep reading the shared store's previous credential until the caller
      // commits the verified candidate.
      const candidateStore = createMemoryCredentialStore(credential);
      let verified = false;
      if (deps.verifyConnection) {
        try {
          await deps.verifyConnection({
            serverName: input.serverName,
            config: { ...input.config, oauth: { ...input.config.oauth, scopes: configured } },
            store: candidateStore,
            signal: input.signal,
          });
          verified = true;
        } catch {
          await revokeCandidateTokens({
            store: candidateStore,
            serverName: input.serverName,
            authorization: discovered.authorization,
            fetch: fetchImpl,
            signal: input.signal,
          });
          throw new McpOAuthError(
            "oauth-login-verification-failed",
            "OAuth authorization succeeded, but the MCP server rejected the credential",
          );
        }
      }
      const finalCredential = (await candidateStore.get(input.serverName)) ?? credential;
      return {
        status: "valid",
        scopes: [...finalCredential.tokens.scope],
        verified,
        credential: finalCredential,
      };
    } finally {
      await liveCallback.close();
    }
  }

/**
 * Operation-local credential store used to verify a candidate credential.
 *
 * It supports the same surface as the shared store so a one-shot
 * `McpOAuthRuntime` can perform a single 401 refresh and refresh-token
 * rotation, but every write stays in this operation's memory.
 */
function createMemoryCredentialStore(
  initial: McpOAuthCredentialRecord,
): McpOAuthCredentialStore {
  let value: McpOAuthCredentialRecord | undefined = initial;
  let queue: Promise<unknown> = Promise.resolve();
  const withLock = async <T>(operation: () => Promise<T>): Promise<T> => {
    const run = queue.then(operation, operation);
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
  return {
    get: async () => value,
    set: async (_name, next) => { value = next; },
    delete: async () => { const had = value !== undefined; value = undefined; return had; },
    takeAndDelete: async () => { const previous = value; value = undefined; return previous; },
    readLogoutEpoch: async () => 0,
    update: async (_name, mutate) => withLock(async () => {
      const next = mutate(value);
      if (next !== value) value = next ? { ...next, revision: (value?.revision ?? 0) + 1 } : undefined;
      return value;
    }),
    runExclusive: async (_name, operation) =>
      withLock(async () => {
        const nextRevision = (value?.revision ?? 0) + 1;
        const { next, result } = await operation(value, {
          nextRevision,
          logoutEpoch: 0,
        });
        if (next !== value) value = next ? { ...next, revision: nextRevision } : undefined;
        return result;
      }),
  };
}

async function revokeCandidateTokens(input: {
  store: McpOAuthCredentialStore;
  serverName: string;
  authorization: OAuthAuthorizationServerMetadata;
  fetch: typeof fetch;
  signal?: AbortSignal;
}): Promise<void> {
  const credential = await input.store.get(input.serverName);
  const endpoint = credential?.binding.revocationEndpoint ?? input.authorization.revocation_endpoint;
  if (!credential || !endpoint) return;
  if (credential.tokens.refreshToken) {
    await revokeToken({ endpoint, token: credential.tokens.refreshToken, hint: "refresh_token", registration: credential.registration, fetch: input.fetch, signal: input.signal }).catch(() => undefined);
  }
  await revokeToken({ endpoint, token: credential.tokens.accessToken, hint: "access_token", registration: credential.registration, fetch: input.fetch, signal: input.signal }).catch(() => undefined);
}

/**
 * Best-effort remote revocation of one credential.
 *
 * When `credential` is provided the caller already removed it from the shared
 * store; this function then never reads the store again, so it can never revoke
 * a different login. Otherwise the record is atomically taken and deleted first.
 */
export async function revokeMcpOAuthCredential(input: {
  serverName: string;
  store: McpOAuthCredentialStore;
  credential?: McpOAuthCredentialRecord;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}): Promise<void> {
  const credential = Object.hasOwn(input, "credential") ? input.credential : await input.store.takeAndDelete(input.serverName);
  if (!credential?.binding.revocationEndpoint) return;
  if (credential.tokens.refreshToken) {
    await revokeToken({ endpoint: credential.binding.revocationEndpoint, token: credential.tokens.refreshToken, hint: "refresh_token", registration: credential.registration, fetch: input.fetch ?? fetch, signal: input.signal }).catch(() => undefined);
  }
  await revokeToken({ endpoint: credential.binding.revocationEndpoint, token: credential.tokens.accessToken, hint: "access_token", registration: credential.registration, fetch: input.fetch ?? fetch, signal: input.signal }).catch(() => undefined);
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
      client_name: "Vykor CLI",
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

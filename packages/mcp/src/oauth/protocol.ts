import type { McpOAuthCredentialRecord } from "@openharness/core";
import {
  discoverOAuthServerInfo,
  extractWWWAuthenticateParams,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { McpOAuthError } from "./errors.js";
import { assertOAuthEndpoint, parseScopes } from "./security.js";

export interface OAuthProtectedResourceMetadata {
  resource?: string;
  authorization_servers?: string[];
  scopes_supported?: string[];
}

export interface OAuthAuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  revocation_endpoint?: string;
  scopes_supported?: string[];
  authorization_response_iss_parameter_supported?: boolean;
  token_endpoint_auth_methods_supported?: string[];
}

export interface OAuthTokenResponse {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
}

export async function discoverOAuth(
  serverUrl: string,
  fetchImpl: typeof fetch,
  options: { allowLoopbackHttp?: boolean; signal?: AbortSignal } = {},
): Promise<{ resource: OAuthProtectedResourceMetadata; authorization: OAuthAuthorizationServerMetadata }> {
  const target = new URL(serverUrl);
  assertOAuthEndpoint(target, options);
  const challenge = await timedFetch(fetchImpl, target, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "openharness", version: "1.0.0" } } }),
    signal: options.signal,
  }).catch(() => undefined);
  const challengedMetadata = challenge
    ? extractWWWAuthenticateParams(challenge).resourceMetadataUrl
    : undefined;
  if (challenge?.ok && !challengedMetadata) {
    throw new McpOAuthError("oauth-not-required", "MCP server accepts unauthenticated connections");
  }
  if (challengedMetadata) assertOAuthEndpoint(challengedMetadata, options);
  const fetchWithTimeout = ((request: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    timedFetch(fetchImpl, request as any, { ...(init as RequestInit), signal: options.signal ?? init?.signal })) as typeof fetch;
  const discovered = await discoverOAuthServerInfo(target, {
    resourceMetadataUrl: challengedMetadata,
    fetchFn: fetchWithTimeout as any,
  }).catch(error => {
    void error;
    throw new McpOAuthError("oauth-discovery-failed", `OAuth discovery failed: ${target.origin}`);
  });
  const resource = discovered.resourceMetadata as OAuthProtectedResourceMetadata | undefined;
  if (!resource) throw new McpOAuthError("oauth-discovery-failed", `OAuth protected resource discovery failed: ${target.origin}`);
  if (resource.resource && new URL(resource.resource).origin !== target.origin) {
    throw new McpOAuthError("oauth-resource-mismatch", "OAuth resource metadata does not match MCP endpoint");
  }
  const issuer = resource.authorization_servers?.[0] ?? discovered.authorizationServerUrl;
  if (!issuer) throw new McpOAuthError("oauth-discovery-failed", "OAuth metadata has no authorization server");
  const issuerUrl = new URL(issuer);
  assertOAuthEndpoint(issuerUrl, options);
  const authorization = discovered.authorizationServerMetadata as OAuthAuthorizationServerMetadata | undefined;
  if (!authorization) throw new McpOAuthError("oauth-discovery-failed", "OAuth authorization server metadata is unavailable");
  if (authorization.issuer.replace(/\/$/, "") !== issuer.replace(/\/$/, "")) {
    throw new McpOAuthError("oauth-issuer-mismatch", "OAuth issuer does not match discovery metadata");
  }
  for (const endpoint of [authorization.authorization_endpoint, authorization.token_endpoint, authorization.registration_endpoint, authorization.revocation_endpoint]) {
    if (endpoint) assertOAuthEndpoint(new URL(endpoint), options);
  }
  return { resource, authorization };
}

export async function requestOAuthToken(input: {
  endpoint: string;
  registration: McpOAuthCredentialRecord["registration"];
  params: URLSearchParams;
  fetch: typeof fetch;
  signal?: AbortSignal;
}): Promise<OAuthTokenResponse> {
  const headers = new Headers({ accept: "application/json", "content-type": "application/x-www-form-urlencoded" });
  applyClientAuthentication(headers, input.params, input.registration);
  const response = await timedFetch(input.fetch, input.endpoint, {
    method: "POST",
    headers,
    body: input.params,
    signal: input.signal,
  });
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok || typeof body.access_token !== "string") {
    const code = body.error === "invalid_grant" ? "oauth-invalid-grant" : "oauth-token-failed";
    throw new McpOAuthError(code, `OAuth token request failed: ${response.status}`);
  }
  return body as unknown as OAuthTokenResponse;
}

export function applyClientAuthentication(
  headers: Headers,
  params: URLSearchParams,
  registration: McpOAuthCredentialRecord["registration"],
): void {
  const method = registration.token_endpoint_auth_method ?? (registration.client_secret ? "client_secret_basic" : "none");
  if (method === "client_secret_basic") {
    if (!registration.client_secret) throw new McpOAuthError("oauth-client-auth-failed", "OAuth client secret is unavailable");
    headers.set("authorization", `Basic ${Buffer.from(`${encodeURIComponent(registration.client_id)}:${encodeURIComponent(registration.client_secret)}`).toString("base64")}`);
    return;
  }
  params.set("client_id", registration.client_id);
  if (method === "client_secret_post") {
    if (!registration.client_secret) throw new McpOAuthError("oauth-client-auth-failed", "OAuth client secret is unavailable");
    params.set("client_secret", registration.client_secret);
  } else if (method !== "none") {
    throw new McpOAuthError("oauth-client-auth-unsupported", `Unsupported OAuth client authentication method: ${method}`);
  }
}

export async function revokeToken(input: {
  endpoint: string;
  token: string;
  hint: "access_token" | "refresh_token";
  registration: McpOAuthCredentialRecord["registration"];
  fetch: typeof fetch;
  signal?: AbortSignal;
}): Promise<void> {
  const params = new URLSearchParams({ token: input.token, token_type_hint: input.hint });
  const headers = new Headers({ "content-type": "application/x-www-form-urlencoded" });
  applyClientAuthentication(headers, params, input.registration);
  await timedFetch(input.fetch, input.endpoint, { method: "POST", headers, body: params, signal: input.signal });
}

export function tokenScopes(response: OAuthTokenResponse, inherited: readonly string[]): string[] {
  return response.scope === undefined ? [...inherited] : parseScopes(response.scope);
}

export async function timedFetch(
  fetchImpl: typeof fetch,
  input: string | URL | Request,
  init: RequestInit = {},
  timeoutMs = 15_000,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new McpOAuthError("oauth-request-timeout", "OAuth request timed out", true)), timeoutMs);
  timer.unref?.();
  const signals = [controller.signal, init.signal].filter(Boolean) as AbortSignal[];
  const signal = signals.length === 1 ? signals[0] : AbortSignal.any(signals);
  try {
    return await fetchImpl(input, { ...init, signal });
  } finally {
    clearTimeout(timer);
  }
}

import type { McpOAuthCredentialRecord, McpRemoteServerConfig } from "@vykor/core";
import { McpOAuthError } from "./errors.js";
import { assertOAuthEndpoint } from "./security.js";

/** Where the protected-resource metadata for this flow was discovered. */
export type ResourceDiscoverySource =
  | "challenge"
  | "endpoint-well-known"
  | "origin-well-known"
  | "explicit";

export interface ResourceBindingInput {
  endpoint: string;
  expectedResource: string;
  metadataResource: string;
  source: ResourceDiscoverySource;
  allowLoopbackHttp?: boolean;
}

/**
 * Parse and normalize a resource identity.
 *
 * Only scheme, host and default port are normalized by the URL standard; path,
 * query and trailing slash are preserved so a mismatch is never smoothed over.
 */
export function normalizeResourceUrl(
  value: string,
  options: { allowLoopbackHttp?: boolean } = {},
): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new McpOAuthError("oauth-resource-mismatch", "OAuth resource URL is invalid");
  }
  assertOAuthEndpoint(url, options);
  return url;
}

/** The stored resource was verified at login; configuration changes still invalidate it. */
export function credentialBindingMatches(config: McpRemoteServerConfig, credential: McpOAuthCredentialRecord): boolean {
  try {
    if (credential.serverUrl !== config.url) return false;
    const resource = credential.binding.resourceUrl ?? credential.serverUrl;
    if (config.oauth?.resourceUrl && new URL(config.oauth.resourceUrl).href !== resource) return false;
    if (credential.binding.configuredResourceUrl !== undefined && credential.binding.configuredResourceUrl !== (config.oauth?.resourceUrl ?? null)) return false;
    if (credential.binding.configuredCallbackUrl !== undefined && credential.binding.configuredCallbackUrl !== (config.oauth?.callbackUrl ?? null)) return false;
    if (credential.binding.configuredCallbackPort !== undefined && credential.binding.configuredCallbackPort !== (config.oauth?.callbackPort ?? null)) return false;
    if (credential.binding.configuredClientId !== undefined && credential.binding.configuredClientId !== (config.oauth?.clientId ?? null)) return false;
    if (config.oauth?.callbackUrl && new URL(config.oauth.callbackUrl).href !== credential.binding.redirectUri) return false;
    if (config.oauth?.callbackPort !== undefined && Number(new URL(credential.binding.redirectUri).port || 80) !== config.oauth.callbackPort) return false;
    if (config.oauth?.clientId && config.oauth.clientId !== credential.registration.client_id) return false;
    return endpointBelongsToResource(new URL(config.url), new URL(resource));
  } catch { return false; }
}

/**
 * Validate that discovered metadata actually describes the resource we asked
 * about, then that the MCP endpoint belongs to it.
 *
 * The metadata `resource` must equal the expected identity as a full string;
 * we never reduce, re-order or decode it into agreement. Returns the verified
 * resource URL to reuse for authorization, token exchange and refresh.
 */
export function validateResourceBinding(input: ResourceBindingInput): URL {
  if (typeof input.metadataResource !== "string" || input.metadataResource.length === 0) {
    throw new McpOAuthError("oauth-resource-mismatch", "OAuth resource metadata has no resource identifier");
  }
  const expected = normalizeResourceUrl(input.expectedResource, { allowLoopbackHttp: input.allowLoopbackHttp });
  if (input.metadataResource !== input.expectedResource) {
    throw new McpOAuthError("oauth-resource-mismatch", "OAuth resource metadata does not match the discovered resource");
  }
  const endpoint = new URL(input.endpoint);
  if (!endpointBelongsToResource(endpoint, expected)) {
    throw new McpOAuthError("oauth-resource-mismatch", "MCP endpoint is not contained by the OAuth resource");
  }
  return expected;
}

/**
 * Whether `endpoint` is the resource itself or sits under its full path segment.
 *
 * Same scheme/host/port is required; `/api` never covers `/api-other`. A
 * resource query must match the endpoint query exactly. Encoded path
 * separators make the comparison ambiguous and are rejected.
 */
export function endpointBelongsToResource(endpoint: URL, resource: URL): boolean {
  if (
    endpoint.protocol !== resource.protocol ||
    endpoint.hostname !== resource.hostname ||
    endpoint.port !== resource.port
  ) return false;
  if (hasEncodedSeparator(endpoint.pathname) || hasEncodedSeparator(resource.pathname)) return false;
  const resourcePath = resource.pathname;
  if (resourcePath !== "/" && resourcePath !== "") {
    const childPrefix = resourcePath.endsWith("/") ? resourcePath : `${resourcePath}/`;
    if (endpoint.pathname !== resourcePath && !endpoint.pathname.startsWith(childPrefix)) return false;
  }
  if (resource.search && endpoint.search !== resource.search) return false;
  return true;
}

/**
 * Candidate protected-resource metadata URLs for a base URL, in RFC 9728 order:
 * the path-aware well-known first (unless the path is root), then the origin
 * root fallback. Query is preserved for the path-aware candidate.
 */
export function resourceMetadataCandidates(base: URL): Array<{ url: URL; source: ResourceDiscoverySource }> {
  const candidates: Array<{ url: URL; source: ResourceDiscoverySource }> = [];
  if (base.pathname !== "/") {
    const pathUrl = new URL(`/.well-known/oauth-protected-resource${base.pathname}`, base.origin);
    pathUrl.search = base.search;
    candidates.push({ url: pathUrl, source: "endpoint-well-known" });
  }
  candidates.push({ url: new URL("/.well-known/oauth-protected-resource", base.origin), source: "origin-well-known" });
  return candidates;
}

function hasEncodedSeparator(pathname: string): boolean {
  return /%2f|%5c|\\/i.test(pathname);
}

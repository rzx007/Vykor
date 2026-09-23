import { createHash } from "node:crypto";
import type {
  McpAuthMode,
  McpAuthServerSnapshot,
  McpOAuthCredentialRecord,
  McpRuntimeStatus,
  McpServerConfig,
  McpServerIdentity,
} from "@openharness/core";
import { oauthScopesChanged, resolveMcpAuthMode, resolveMcpOAuthStatus } from "./status.js";

/**
 * Normalize an MCP endpoint URL.
 *
 * The URL parser lowercases the host, drops default ports and can strip the
 * fragment. Path and query are preserved because they can carry resource
 * identity. URLs with embedded credentials are rejected so secrets can never
 * enter an identity.
 */
export function normalizeMcpEndpoint(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.username || url.password) return undefined;
  url.hash = "";
  return url.href;
}

export function fingerprintMcpEndpoint(endpoint: string): string {
  return createHash("sha256").update(endpoint).digest("base64url");
}

/**
 * Secret-free list summary for a remote endpoint: scheme, host (and port) and
 * path only. Userinfo, query string and fragment are dropped because they can
 * carry tokens. Returns `undefined` for malformed URLs.
 */
export function summarizeMcpEndpoint(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.href;
}

/**
 * Build the cross-process identity for an HTTP MCP server.
 *
 * Returns `undefined` for stdio/SSE configs, malformed URLs and URLs with
 * embedded credentials. The endpoint is normalized, never returned with
 * credentials, and the fingerprint is the only value meant for the wire.
 */
export function createMcpServerIdentity(
  name: string,
  config: McpServerConfig,
): McpServerIdentity | undefined {
  if (config.type !== "http") return undefined;
  const endpoint = normalizeMcpEndpoint(config.url);
  if (endpoint === undefined) return undefined;
  return {
    name,
    transport: "http",
    endpoint,
    endpointFingerprint: fingerprintMcpEndpoint(endpoint),
  };
}

export interface BuildMcpAuthServerSnapshotInput {
  name: string;
  config: McpServerConfig;
  credential: McpOAuthCredentialRecord | undefined;
  runtimeStatus: McpRuntimeStatus;
  now?: number;
}

/**
 * Build the single secret-free authentication snapshot shared by CLI, server
 * and desktop. It never returns tokens, client secrets, Authorization headers,
 * callback URLs or full OAuth endpoint queries.
 */
export function buildMcpAuthServerSnapshot(
  input: BuildMcpAuthServerSnapshotInput,
): McpAuthServerSnapshot {
  const { name, config, credential, runtimeStatus } = input;
  const now = input.now ?? Date.now();
  const endpoint = config.type === "stdio" ? undefined : normalizeMcpEndpoint(config.url);
  const authMode: McpAuthMode = resolveMcpAuthMode(config, credential);
  const matchedPresence =
    config.type === "http" && credential !== undefined && credential.serverUrl === config.url;
  const scopeChanged = matchedPresence && oauthScopesChanged(config.oauth?.scopes, credential!.tokens.scope);
  const scopes =
    config.type === "stdio"
      ? []
      : matchedPresence && !scopeChanged
        ? [...credential!.tokens.scope]
        : [...(config.oauth?.scopes ?? [])];

  return {
    name,
    enabled: config.enabled !== false,
    transport: config.type,
    ...(endpoint === undefined ? {} : { endpoint }),
    authMode,
    authStatus: resolveMcpOAuthStatus(config, credential, now),
    scopes,
    runtimeStatus,
  };
}

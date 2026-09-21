import type {
  McpAuthMode,
  McpOAuthAuthStatus,
  McpOAuthCredentialRecord,
  McpServerConfig,
} from "@openharness/core";

/**
 * Resolve how an MCP server authenticates.
 *
 * Priority follows the transport behavior: an explicit static `Authorization`
 * header always wins, then OAuth (declared in settings or backed by a matching
 * credential). stdio and SSE servers report `none` in this phase.
 */
export function resolveMcpAuthMode(
  config: McpServerConfig,
  credential: McpOAuthCredentialRecord | undefined,
): McpAuthMode {
  if (config.type !== "http") return "none";
  const authorization = findAuthorizationHeader(config.headers);
  if (authorization !== undefined) {
    return /^bearer\s+\S/i.test(authorization.trim()) ? "bearer" : "custom";
  }
  if (config.oauth !== undefined) return "oauth";
  if (credential !== undefined && credential.serverUrl === config.url) return "oauth";
  return "none";
}

function findAuthorizationHeader(headers?: Record<string, string>): string | undefined {
  if (!headers) return undefined;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === "authorization") return value;
  }
  return undefined;
}

export function resolveMcpOAuthStatus(
  config: McpServerConfig,
  credential: McpOAuthCredentialRecord | undefined,
  now = Date.now(),
): McpOAuthAuthStatus {
  if (config.type === "stdio" || config.type === "sse") return "unsupported";
  if (config.headers && Object.keys(config.headers).some(key => key.toLowerCase() === "authorization")) return "static";
  return credential ? credentialStatus(config.url, credential, now) : "not-logged-in";
}

function credentialStatus(serverUrl: string, credential: McpOAuthCredentialRecord, now: number): McpOAuthAuthStatus {
  if (credential.diagnostic?.code === "reauthentication-required") return "reauthentication-required";
  if (credential.serverUrl !== serverUrl) return "reauthentication-required";
  if (credential.registration.client_secret_expires_at && credential.registration.client_secret_expires_at * 1000 <= now) {
    return "reauthentication-required";
  }
  if (!credential.tokens.expiresAt || credential.tokens.expiresAt > now) return "valid";
  return credential.tokens.refreshToken ? "expired-refreshable" : "reauthentication-required";
}

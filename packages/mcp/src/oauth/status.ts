import type {
  McpOAuthAuthStatus,
  McpOAuthCredentialRecord,
  McpServerConfig,
} from "@openharness/core";

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

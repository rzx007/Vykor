import { McpOAuthError } from "./errors.js";

export function assertOAuthEndpoint(
  url: URL,
  options: { allowLoopbackHttp?: boolean } = {},
): void {
  if (url.username || url.password || url.hash) {
    throw new McpOAuthError("unsafe-oauth-endpoint", `Unsafe OAuth endpoint: ${url.origin}`);
  }
  if (url.protocol === "https:") return;
  if (
    options.allowLoopbackHttp &&
    url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "::1")
  ) return;
  throw new McpOAuthError("unsafe-oauth-endpoint", `OAuth endpoint must use HTTPS: ${url.origin}`);
}

export function assertIssuer(actual: string | undefined, expected: string, required = true): void {
  if ((!actual && required) || (actual && normalizeIssuer(actual) !== normalizeIssuer(expected))) {
    throw new McpOAuthError("oauth-issuer-mismatch", "OAuth issuer does not match discovery metadata");
  }
}

export function assertScopeSubset(received: readonly string[], approved: readonly string[]): void {
  const allowed = new Set(approved);
  const extra = [...new Set(received)].filter(scope => !allowed.has(scope));
  if (extra.length) {
    throw new McpOAuthError(
      "oauth-scope-expansion",
      `OAuth server returned unapproved scopes: ${extra.join(", ")}`,
    );
  }
}

export function parseScopes(value: unknown): string[] {
  if (Array.isArray(value)) return uniqueScopes(value.filter(item => typeof item === "string"));
  if (typeof value !== "string") return [];
  return uniqueScopes(value.split(/\s+/).filter(Boolean));
}

export function uniqueScopes(scopes: readonly string[]): string[] {
  return [...new Set(scopes.map(scope => scope.trim()).filter(Boolean))];
}

function normalizeIssuer(value: string): string {
  return value.replace(/\/$/, "");
}

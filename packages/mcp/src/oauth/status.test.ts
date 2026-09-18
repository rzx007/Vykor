import { describe, expect, it } from "vitest";
import type { McpOAuthCredentialRecord } from "@openharness/core";
import { resolveMcpOAuthStatus } from "./status.js";

const now = 10_000;
const credential: McpOAuthCredentialRecord = {
  serverUrl: "https://mcp.test/mcp",
  revision: 1,
  binding: { issuer: "https://auth.test", redirectUri: "http://127.0.0.1/cb", authorizationEndpoint: "https://auth.test/a", tokenEndpoint: "https://auth.test/t" },
  registration: { client_id: "c" },
  tokens: { accessToken: "secret", refreshToken: "refresh", tokenType: "Bearer", scope: ["read"], expiresAt: now - 1 },
};

describe("resolveMcpOAuthStatus", () => {
  it("is pure and reports refreshable expiry", () => {
    expect(resolveMcpOAuthStatus({ type: "http", url: credential.serverUrl, oauth: { scopes: ["read"] } }, credential, now)).toBe("expired-refreshable");
  });

  it("gives static authorization and diagnostics priority", () => {
    expect(resolveMcpOAuthStatus({ type: "http", url: credential.serverUrl, headers: { Authorization: "Bearer x" } }, credential, now)).toBe("static");
    expect(resolveMcpOAuthStatus(
      { type: "http", url: credential.serverUrl, oauth: {} },
      { ...credential, diagnostic: { code: "reauthentication-required", updatedAt: now } },
      now,
    )).toBe("reauthentication-required");
  });
});

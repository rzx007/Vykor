import { describe, expect, it } from "vitest";
import type { McpOAuthCredentialRecord } from "@openharness/core";
import { resolveMcpAuthMode, resolveMcpOAuthStatus } from "./status.js";

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

  it("requires reauthorization for any configured scope-set change", () => {
    const granted = { ...credential, tokens: { ...credential.tokens, scope: ["read", "write"] } };
    expect(resolveMcpOAuthStatus({ type: "http", url: credential.serverUrl, oauth: { scopes: ["write", "read"] } }, granted, now)).toBe("expired-refreshable");
    expect(resolveMcpOAuthStatus({ type: "http", url: credential.serverUrl, oauth: { scopes: ["read"] } }, granted, now)).toBe("reauthentication-required");
    expect(resolveMcpOAuthStatus({ type: "http", url: credential.serverUrl, oauth: { scopes: ["read", "write", "admin"] } }, granted, now)).toBe("reauthentication-required");
    expect(resolveMcpOAuthStatus({ type: "http", url: credential.serverUrl }, granted, now)).toBe("expired-refreshable");
  });
});

describe("resolveMcpAuthMode", () => {
  it("recognizes bearer case-insensitively and custom schemes", () => {
    expect(resolveMcpAuthMode({ type: "http", url: credential.serverUrl, headers: { authorization: "bearer x" } }, undefined)).toBe("bearer");
    expect(resolveMcpAuthMode({ type: "http", url: credential.serverUrl, headers: { Authorization: "Basic abc" } }, undefined)).toBe("custom");
  });

  it("prefers explicit headers over matching OAuth credentials", () => {
    expect(resolveMcpAuthMode({ type: "http", url: credential.serverUrl, headers: { Authorization: "Bearer x" } }, credential)).toBe("bearer");
  });

  it("detects oauth from declared settings or a matching credential", () => {
    expect(resolveMcpAuthMode({ type: "http", url: credential.serverUrl, oauth: {} }, undefined)).toBe("oauth");
    expect(resolveMcpAuthMode({ type: "http", url: credential.serverUrl }, credential)).toBe("oauth");
  });

  it("returns none without auth config or a non-http transport", () => {
    expect(resolveMcpAuthMode({ type: "http", url: credential.serverUrl }, undefined)).toBe("none");
    expect(resolveMcpAuthMode({ type: "http", url: "https://other.test/mcp" }, credential)).toBe("none");
    expect(resolveMcpAuthMode({ type: "stdio", command: "node" }, credential)).toBe("none");
    expect(resolveMcpAuthMode({ type: "sse", url: "https://x.test/sse", headers: { Authorization: "Bearer x" } }, undefined)).toBe("none");
  });
});

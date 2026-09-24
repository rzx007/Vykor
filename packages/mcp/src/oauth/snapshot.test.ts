import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { McpOAuthCredentialRecord, McpServerConfig } from "@vykor/core";
import {
  buildMcpAuthServerSnapshot,
  createMcpServerIdentity,
  fingerprintMcpEndpoint,
  normalizeMcpEndpoint,
} from "./snapshot.js";

const now = 10_000;
const activeCredential: McpOAuthCredentialRecord = {
  serverUrl: "https://mcp.linear.app/mcp",
  revision: 1,
  binding: {
    issuer: "https://auth.linear.app",
    redirectUri: "http://127.0.0.1/cb",
    authorizationEndpoint: "https://auth.linear.app/a",
    tokenEndpoint: "https://auth.linear.app/t",
  },
  registration: { client_id: "client" },
  tokens: {
    accessToken: "secret-token",
    refreshToken: "refresh",
    tokenType: "Bearer",
    scope: ["read", "write"],
    expiresAt: now + 60_000,
  },
};

describe("createMcpServerIdentity", () => {
  it("normalizes endpoint identity and keeps the query", () => {
    expect(
      createMcpServerIdentity("linear", {
        type: "http",
        url: "https://MCP.Linear.app:443/mcp?tenant=a#fragment",
      }),
    ).toEqual({
      name: "linear",
      transport: "http",
      endpoint: "https://mcp.linear.app/mcp?tenant=a",
      endpointFingerprint: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    });
  });

  it("produces a stable base64url sha256 fingerprint", () => {
    const endpoint = "https://mcp.linear.app/mcp";
    expect(fingerprintMcpEndpoint(endpoint)).toBe(
      createHash("sha256").update(endpoint).digest("base64url"),
    );
  });

  it("returns undefined for non-HTTP transports and credential-bearing URLs", () => {
    expect(
      createMcpServerIdentity("local", { type: "stdio", command: "node" }),
    ).toBeUndefined();
    expect(
      createMcpServerIdentity("legacy", { type: "sse", url: "https://x.test/sse" }),
    ).toBeUndefined();
    expect(
      createMcpServerIdentity("userinfo", {
        type: "http",
        url: "https://user:pass@mcp.linear.app/mcp",
      }),
    ).toBeUndefined();
  });

  it("exposes no username or password in the normalized endpoint", () => {
    expect(normalizeMcpEndpoint("https://user:pass@mcp.linear.app/mcp")).toBeUndefined();
    expect(normalizeMcpEndpoint("not a url")).toBeUndefined();
  });
});

describe("buildMcpAuthServerSnapshot", () => {
  it("does not expose endpoint query credentials in a public snapshot", () => {
    const snapshot = buildMcpAuthServerSnapshot({
      name: "private",
      config: { type: "http", url: "https://mcp.example/mcp?token=query-secret" },
      credential: undefined,
      runtimeStatus: "unavailable",
    });
    expect(snapshot.endpoint).toBe("https://mcp.example/mcp");
    expect(JSON.stringify(snapshot)).not.toContain("query-secret");
  });

  it("reflects the enabled flag and defaults omitted servers to enabled", () => {
    const disabled = buildMcpAuthServerSnapshot({
      name: "off",
      config: { type: "stdio", command: "node", enabled: false },
      credential: undefined,
      runtimeStatus: "disconnected",
    });
    expect(disabled.enabled).toBe(false);

    const defaulted = buildMcpAuthServerSnapshot({
      name: "on",
      config: { type: "stdio", command: "node" },
      credential: undefined,
      runtimeStatus: "disconnected",
    });
    expect(defaulted.enabled).toBe(true);
  });

  it("prefers an explicit Bearer header over residual OAuth credentials", () => {
    const snapshot = buildMcpAuthServerSnapshot({
      name: "linear",
      config: {
        type: "http",
        url: activeCredential.serverUrl,
        headers: { Authorization: "Bearer static-token" },
      },
      credential: activeCredential,
      runtimeStatus: "unavailable",
      now,
    });
    expect(snapshot).toMatchObject({ authMode: "bearer", authStatus: "static" });
    expect(JSON.stringify(snapshot)).not.toContain("static-token");
    expect(JSON.stringify(snapshot)).not.toContain("secret-token");
  });

  it("classifies non-Bearer Authorization as custom", () => {
    expect(
      buildMcpAuthServerSnapshot({
        name: "linear",
        config: {
          type: "http",
          url: activeCredential.serverUrl,
          headers: { Authorization: "ApiKey abc" },
        },
        credential: undefined,
        runtimeStatus: "unavailable",
        now,
      }),
    ).toMatchObject({ authMode: "custom", authStatus: "static" });
  });

  it("reports oauth/not-logged-in when settings declare oauth without a credential", () => {
    expect(
      buildMcpAuthServerSnapshot({
        name: "linear",
        config: {
          type: "http",
          url: "https://MCP.Linear.app:443/mcp?tenant=a#fragment",
          oauth: { scopes: ["read"] },
        },
        credential: undefined,
        runtimeStatus: "unavailable",
        now,
      }),
    ).toMatchObject({
      name: "linear",
      enabled: true,
      transport: "http",
      endpoint: "https://mcp.linear.app/mcp",
      authMode: "oauth",
      authStatus: "not-logged-in",
      scopes: ["read"],
      runtimeStatus: "unavailable",
    });
  });

  it("reports none/unsupported for stdio servers", () => {
    expect(
      buildMcpAuthServerSnapshot({
        name: "local",
        config: { type: "stdio", command: "node", args: ["server.js"] },
        credential: undefined,
        runtimeStatus: "disconnected",
        now,
      }),
    ).toMatchObject({
      transport: "stdio",
      authMode: "none",
      authStatus: "unsupported",
      scopes: [],
      runtimeStatus: "disconnected",
    });
    expect(
      buildMcpAuthServerSnapshot({
        name: "local",
        config: { type: "stdio", command: "node" },
        credential: undefined,
        runtimeStatus: "disconnected",
        now,
      }).endpoint,
    ).toBeUndefined();
  });

  it("prefers credential scopes over settings scopes when the credential matches", () => {
    expect(
      buildMcpAuthServerSnapshot({
        name: "linear",
        config: {
          type: "http",
          url: activeCredential.serverUrl,
          oauth: { scopes: ["write", "read"] },
        },
        credential: activeCredential,
        runtimeStatus: "connected",
        now,
      }),
    ).toMatchObject({ authMode: "oauth", authStatus: "valid", scopes: ["read", "write"] });
  });

  it("shows desired scopes for a changed-scope reauthorization", () => {
    expect(buildMcpAuthServerSnapshot({
      name: "linear",
      config: { type: "http", url: activeCredential.serverUrl, oauth: { scopes: ["read"] } },
      credential: activeCredential,
      runtimeStatus: "connected",
      now,
    })).toMatchObject({ authMode: "oauth", authStatus: "reauthentication-required", scopes: ["read"] });
  });

  it("keeps oauth mode with not-logged-in after logout when scopes remain in settings", () => {
    expect(
      buildMcpAuthServerSnapshot({
        name: "linear",
        config: { type: "http", url: activeCredential.serverUrl, oauth: { scopes: ["read"] } },
        credential: undefined,
        runtimeStatus: "disconnected",
        now,
      }),
    ).toMatchObject({ authMode: "oauth", authStatus: "not-logged-in", scopes: ["read"] });
  });

  it("reports reauthentication-required when the stored credential binds another URL", () => {
    expect(
      buildMcpAuthServerSnapshot({
        name: "linear",
        config: { type: "http", url: "https://other.test/mcp", oauth: {} },
        credential: activeCredential,
        runtimeStatus: "unavailable",
        now,
      }),
    ).toMatchObject({ authMode: "oauth", authStatus: "reauthentication-required" });
  });

  it("does not claim oauth mode when an unmatched credential has no oauth config", () => {
    expect(
      buildMcpAuthServerSnapshot({
        name: "linear",
        config: { type: "http", url: "https://other.test/mcp" },
        credential: activeCredential,
        runtimeStatus: "unavailable",
        now,
      }),
    ).toMatchObject({ authMode: "none", authStatus: "reauthentication-required" });
  });

  it("never serializes tokens, secrets or the full callback URL", () => {
    const config: McpServerConfig = {
      type: "http",
      url: activeCredential.serverUrl,
      oauth: { scopes: ["read"] },
    };
    const serialized = JSON.stringify(
      buildMcpAuthServerSnapshot({
        name: "linear",
        config,
        credential: activeCredential,
        runtimeStatus: "connected",
        now,
      }),
    );
    expect(serialized).not.toContain(activeCredential.tokens.accessToken);
    expect(serialized).not.toContain(activeCredential.registration.client_id);
    expect(serialized).not.toContain("127.0.0.1");
  });
});

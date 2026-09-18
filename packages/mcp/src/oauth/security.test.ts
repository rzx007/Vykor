import { describe, expect, it } from "vitest";
import { assertIssuer, assertOAuthEndpoint, assertScopeSubset, parseScopes } from "./security.js";

describe("OAuth security", () => {
  it.each(["http://example.com/mcp", "https://u:p@example.com/mcp", "https://example.com/mcp#secret"])("rejects unsafe endpoint %s", value => {
    expect(() => assertOAuthEndpoint(new URL(value))).toThrow();
  });

  it("allows loopback HTTP only when explicitly enabled", () => {
    expect(() => assertOAuthEndpoint(new URL("http://127.0.0.1:3000/mcp"))).toThrow();
    expect(() => assertOAuthEndpoint(new URL("http://127.0.0.1:3000/mcp"), { allowLoopbackHttp: true })).not.toThrow();
  });

  it("checks issuer and scope without ordering sensitivity", () => {
    expect(() => assertIssuer("https://auth.test/", "https://auth.test")).not.toThrow();
    expect(() => assertIssuer("https://evil.test", "https://auth.test")).toThrow();
    expect(() => assertScopeSubset(["read", "write"], ["read"])).toThrow();
    expect(parseScopes("read  read write")).toEqual(["read", "write"]);
  });
});

import { describe, expect, it } from "vitest";

import {
  MCP_OAUTH_LOGIN_COMPLETED_EVENT,
  MAX_OAUTH_ID_LENGTH,
  parseMcpOAuthCallbackInput,
  parseMcpOAuthLoginInput,
  parseOAuthOperationEvent,
  parseOAuthOperationView,
} from "./mcp-oauth.js";

describe("MCP OAuth wire validation", () => {
  it("accepts a well-formed login input and normalizes optional scopes", () => {
    expect(parseMcpOAuthLoginInput({
      oauthInstanceId: "inst",
      requestId: "req",
      scopes: ["read", "write"],
      callbackMode: "manual",
    })).toEqual({ oauthInstanceId: "inst", requestId: "req", scopes: ["read", "write"], callbackMode: "manual" });

    expect(parseMcpOAuthLoginInput({ oauthInstanceId: "i", requestId: "r", callbackMode: "local" }))
      .toEqual({ oauthInstanceId: "i", requestId: "r", callbackMode: "local" });
  });

  it.each([
    { label: "missing instance", value: { requestId: "r", callbackMode: "local" } },
    { label: "unknown callback mode", value: { oauthInstanceId: "i", requestId: "r", callbackMode: "auto" } },
    { label: "over-long requestId", value: { oauthInstanceId: "i", requestId: "x".repeat(MAX_OAUTH_ID_LENGTH + 1), callbackMode: "local" } },
    { label: "non-string scope", value: { oauthInstanceId: "i", requestId: "r", callbackMode: "local", scopes: [1] } },
    { label: "too many scopes", value: { oauthInstanceId: "i", requestId: "r", callbackMode: "local", scopes: Array(51).fill("s") } },
  ])("rejects $label", ({ value }) => {
    expect(() => parseMcpOAuthLoginInput(value)).toThrow();
  });

  it("rejects an arbitrary endpoint or redirect override in the login body", () => {
    expect(() => parseMcpOAuthLoginInput({
      oauthInstanceId: "i",
      requestId: "r",
      callbackMode: "local",
      endpoint: "https://evil.test/mcp",
      redirectUrl: "https://evil.test/cb",
    })).not.toThrow(); // unknown fields are ignored, never honored
    expect(Object.keys(parseMcpOAuthLoginInput({
      oauthInstanceId: "i",
      requestId: "r",
      callbackMode: "local",
      endpoint: "https://evil.test/mcp",
    }))).not.toContain("endpoint");
  });

  it("validates a callback body and an operation view", () => {
    expect(parseMcpOAuthCallbackInput({ callbackUrl: "https://app.example/cb?code=c" }))
      .toEqual({ callbackUrl: "https://app.example/cb?code=c" });
    expect(() => parseMcpOAuthCallbackInput({ callbackUrl: "" })).toThrow();
    expect(() => parseMcpOAuthCallbackInput({ callbackUrl: "x".repeat(5_000) })).toThrow();

    expect(parseOAuthOperationView({
      loginId: "l",
      name: "linear",
      state: "completed",
      credentialCommitted: true,
      authorizationReady: true,
      errorCode: "oauth-login-failed",
      authorizationUrl: "https://auth.example/authorize",
    })).toMatchObject({ state: "completed", authorizationUrl: "https://auth.example/authorize" });
    expect(() => parseOAuthOperationView({ loginId: "l", name: "n", state: "wat", credentialCommitted: true, authorizationReady: false })).toThrow();
  });

  it("only accepts the two known completion event shapes", () => {
    const event = parseOAuthOperationEvent({
      event: MCP_OAUTH_LOGIN_COMPLETED_EVENT,
      data: { loginId: "l", name: "n", state: "completed", credentialCommitted: true, authorizationReady: true },
    });
    expect(event.event).toBe(MCP_OAUTH_LOGIN_COMPLETED_EVENT);
    expect(event.data.state).toBe("completed");
    expect(() => parseOAuthOperationEvent({ event: "mcp.oauth.other", data: {} })).toThrow();
  });

  it("preserves runtime warnings when decoding a recovered operation", () => {
    expect(parseOAuthOperationView({
      loginId: "l", name: "n", state: "completed", credentialCommitted: true, authorizationReady: false,
      runtimeSync: { status: "error", affectedRuntimes: 1, failures: [{ runtimeId: "r", message: "MCP runtime synchronization failed" }] },
    })).toMatchObject({ runtimeSync: { status: "error", affectedRuntimes: 1 } });
  });
});

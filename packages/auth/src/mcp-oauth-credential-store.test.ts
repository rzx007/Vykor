import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { McpOAuthCredentialRecord } from "@openharness/core";
import { McpOAuthCredentialStore, shouldReuseCredentialAfterLock } from "./mcp-oauth-credential-store.js";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))));

function credential(token: string): McpOAuthCredentialRecord {
  return {
    serverUrl: "https://mcp.test/mcp",
    revision: 0,
    binding: {
      issuer: "https://auth.test",
      redirectUri: "http://127.0.0.1/callback",
      authorizationEndpoint: "https://auth.test/authorize",
      tokenEndpoint: "https://auth.test/token",
    },
    registration: { client_id: "client", token_endpoint_auth_method: "none" },
    tokens: { accessToken: token, refreshToken: "refresh", tokenType: "Bearer", scope: ["read"], expiresAt: Date.now() + 60_000 },
  };
}

describe("McpOAuthCredentialStore", () => {
  it("preserves concurrent writes from separate instances", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mcp-oauth-store-")); directories.push(dir);
    const file = join(dir, "mcp-oauth.json");
    const a = new McpOAuthCredentialStore(file);
    const b = new McpOAuthCredentialStore(file);
    await Promise.all([a.set("linear", credential("a")), b.set("github", credential("b"))]);
    expect(Object.keys(await a.list()).sort()).toEqual(["github", "linear"]);
  });

  it("does not overwrite a malformed credential file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mcp-oauth-store-")); directories.push(dir);
    const file = join(dir, "mcp-oauth.json");
    await writeFile(file, "{broken", "utf8");
    const store = new McpOAuthCredentialStore(file);
    await expect(store.set("linear", credential("a"))).rejects.toMatchObject({ code: "invalid-mcp-oauth-store" });
    expect(await readFile(file, "utf8")).toBe("{broken");
  });

  it("does not mistake a diagnostic-only revision for refreshed tokens", () => {
    const before = credential("old");
    const current = { ...before, revision: 2, diagnostic: { code: "reauthentication-required" as const, updatedAt: Date.now() } };
    expect(shouldReuseCredentialAfterLock(before, current, Date.now())).toBe(false);
  });
});

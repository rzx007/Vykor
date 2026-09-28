import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { McpOAuthCredentialRecord } from "@vykor/core";
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
  it("waits for another store's lock before reading its persisted logout epoch", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mcp-oauth-store-")); directories.push(dir);
    const file = join(dir, "mcp-oauth.json");
    const first = new McpOAuthCredentialStore(file);
    const second = new McpOAuthCredentialStore(file);
    await first.delete("linear");
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const locked = new Promise<void>(resolve => { entered = resolve; });
    const writer = first.runExclusive("linear", async current => {
      entered();
      await gate;
      return { next: credential("committed"), result: current };
    });
    await locked;
    let completed = false;
    const reading = second.readLogoutEpoch("linear").then(epoch => { completed = true; return epoch; });
    try {
      // One full lock retry interval gives an unlocked read time to finish.
      await new Promise(resolve => setTimeout(resolve, 75));
      expect(completed).toBe(false);
    } finally {
      release();
      await writer;
      await reading;
    }
    await writer;
    await expect(reading).resolves.toBe(1);
    expect((await second.get("linear"))?.tokens.accessToken).toBe("committed");
  });
  it("reports a failed atomic commit as a storage error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mcp-oauth-store-")); directories.push(dir);
    const file = join(dir, "mcp-oauth.json");
    const store = new McpOAuthCredentialStore(file);
    await store.set("linear", credential("old"));
    await expect(store.runExclusive("linear", async () => {
      await rename(file, join(dir, "previous.json"));
      await mkdir(file);
      return { next: credential("rotated"), result: undefined };
    })).rejects.toMatchObject({ name: "McpOAuthStoreError", code: "credential-storage-failed" });
  });
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

  it("treats an unchanged operation result as a no-op: no write, no revision bump", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mcp-oauth-store-")); directories.push(dir);
    const file = join(dir, "mcp-oauth.json");
    const store = new McpOAuthCredentialStore(file);
    await store.set("linear", credential("a"));
    const bytes = await readFile(file, "utf8");
    const revision = (await store.get("linear"))!.revision;

    await store.runExclusive("linear", async current => ({ next: current, result: undefined }));

    expect(await readFile(file, "utf8")).toBe(bytes);
    expect((await store.get("linear"))!.revision).toBe(revision);
  });

  it("does not revive a deleted credential from a stale diagnostic update", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mcp-oauth-store-")); directories.push(dir);
    const file = join(dir, "mcp-oauth.json");
    const a = new McpOAuthCredentialStore(file);
    const b = new McpOAuthCredentialStore(file);
    await a.set("linear", credential("a"));

    await b.delete("linear");
    const revived = await b.update("linear", current =>
      current ? { ...current, diagnostic: { code: "reauthentication-required" as const, updatedAt: Date.now() } } : current,
    );

    expect(revived).toBeUndefined();
    expect(await b.get("linear")).toBeUndefined();
    expect(JSON.parse(await readFile(file, "utf8")).servers.linear).toBeUndefined();
  });

  it("reads version 1 without rewriting and upgrades atomically on the first real write", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mcp-oauth-store-")); directories.push(dir);
    const file = join(dir, "mcp-oauth.json");
    const v1 = { version: 1, servers: { linear: credential("linear") } };
    await writeFile(file, JSON.stringify(v1), "utf8");

    const store = new McpOAuthCredentialStore(file);
    expect((await store.get("linear"))?.tokens.accessToken).toBe("linear");
    expect(AtomicVersion(await readFile(file, "utf8"))).toBe(1);

    await store.set("github", credential("github"));

    const upgraded = JSON.parse(await readFile(file, "utf8"));
    expect(upgraded.version).toBe(2);
    expect(upgraded.logoutEpochs).toEqual({});
    expect(Object.keys(upgraded.servers).sort()).toEqual(["github", "linear"]);
    expect(upgraded.servers.linear.tokens.accessToken).toBe("linear");
  });

  it("keeps version 1 readable through get/list without a write", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mcp-oauth-store-")); directories.push(dir);
    const file = join(dir, "mcp-oauth.json");
    const v1 = { version: 1, servers: { linear: credential("linear") } };
    await writeFile(file, JSON.stringify(v1), "utf8");
    const store = new McpOAuthCredentialStore(file);

    await store.list();
    await store.readLogoutEpoch("linear");
    expect(await readFile(file, "utf8")).toBe(JSON.stringify(v1));
  });

  it("advances the logout epoch even when the target is already absent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mcp-oauth-store-")); directories.push(dir);
    const file = join(dir, "mcp-oauth.json");
    const store = new McpOAuthCredentialStore(file);

    await expect(store.delete("linear")).resolves.toBe(false);
    expect(await store.readLogoutEpoch("linear")).toBe(1);
    await store.takeAndDelete("linear");
    expect(await store.readLogoutEpoch("linear")).toBe(2);
  });

  it("returns the previous record from takeAndDelete and preserves other servers", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mcp-oauth-store-")); directories.push(dir);
    const file = join(dir, "mcp-oauth.json");
    const store = new McpOAuthCredentialStore(file);
    await store.set("linear", credential("a"));
    await store.set("github", credential("b"));

    const removed = await store.takeAndDelete("linear");

    expect(removed?.tokens.accessToken).toBe("a");
    expect(await store.get("linear")).toBeUndefined();
    expect((await store.get("github"))?.tokens.accessToken).toBe("b");
    expect(await store.readLogoutEpoch("linear")).toBe(1);
  });

  it("rejects an unknown store version and an invalid logout epoch", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mcp-oauth-store-")); directories.push(dir);
    const file = join(dir, "mcp-oauth.json");
    await writeFile(file, JSON.stringify({ version: 3, servers: {} }), "utf8");
    await expect(new McpOAuthCredentialStore(file).get("linear")).rejects.toMatchObject({ code: "invalid-mcp-oauth-store" });

    await writeFile(file, JSON.stringify({ version: 2, logoutEpochs: { linear: -1 }, servers: {} }), "utf8");
    await expect(new McpOAuthCredentialStore(file).get("linear")).rejects.toMatchObject({ code: "invalid-mcp-oauth-store" });
  });

  it("refuses to wrap a maximum logout epoch", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mcp-oauth-store-")); directories.push(dir);
    const file = join(dir, "mcp-oauth.json");
    const store = new McpOAuthCredentialStore(file);
    await writeFile(file, JSON.stringify({ version: 2, logoutEpochs: { linear: Number.MAX_SAFE_INTEGER }, servers: {} }), "utf8");

    await expect(store.takeAndDelete("linear")).rejects.toMatchObject({ code: "invalid-mcp-oauth-epoch" });
  });
});

function AtomicVersion(raw: string): number {
  return (JSON.parse(raw) as { version: number }).version;
}

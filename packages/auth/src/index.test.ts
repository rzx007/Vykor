import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ApiKeyFlow, DeviceCodeFlow, AuthManager } from "./index.js";
import { CredentialStorage } from "./credential-storage.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("ApiKeyFlow", () => {
  it("returns credentials with the provided key", async () => {
    const flow = new ApiKeyFlow("sk-test-123");
    const creds = await flow.authenticate();
    expect(creds.provider).toBe("api-key");
    expect(creds.accessToken).toBe("sk-test-123");
  });

  it("refresh returns same key", async () => {
    const flow = new ApiKeyFlow("sk-test");
    const creds = await flow.refresh({ provider: "api-key", accessToken: "old" });
    expect(creds.accessToken).toBe("sk-test");
  });
});

describe("DeviceCodeFlow", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    let callCount = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      callCount++;
      if (url === "https://start") {
        return new Response(JSON.stringify({
          device_code: "dc_123",
          user_code: "ABCD-1234",
          verification_uri: "https://github.com/login/device",
          interval: 0,
          expires_in: 900,
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url === "https://token") {
        if (callCount <= 2) {
          return new Response(JSON.stringify({ error: "authorization_pending" }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        return new Response(JSON.stringify({ access_token: "ghu_test_token", refresh_token: "rft_test", expires_in: 3600 }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response("not found", { status: 404 });
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
  });

  it("exposes name", () => {
    const flow = new DeviceCodeFlow("client-id", "https://start", "https://token");
    expect(flow.name).toBe("device-code");
  });

  it("authenticate returns credentials", async () => {
    const flow = new DeviceCodeFlow("client-id", "https://start", "https://token");
    const creds = await flow.authenticate();
    expect(creds.provider).toBe("device-code");
    expect(creds.accessToken).toBe("ghu_test_token");
    expect(creds.refreshToken).toBe("rft_test");
    expect(creds.expiresAt).toBeDefined();
  });

  it("refresh returns updated credentials", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ access_token: "new_token" }), { status: 200, headers: { "Content-Type": "application/json" } })
    ));
    const flow = new DeviceCodeFlow("client-id", "https://start", "https://token");
    const original = { provider: "device-code", accessToken: "old-token", refreshToken: "rft_old" };
    const refreshed = await flow.refresh(original);
    expect(refreshed.accessToken).toBe("new_token");
  });
});

describe("AuthManager", () => {
  it("registers and authenticates with provider", async () => {
    const mgr = new AuthManager();
    mgr.registerProvider(new ApiKeyFlow("sk-test"));
    const creds = await mgr.authenticate("api-key");
    expect(creds.accessToken).toBe("sk-test");
  });

  it("throws for unknown provider", async () => {
    const mgr = new AuthManager();
    await expect(mgr.authenticate("nope")).rejects.toThrow("Unknown auth provider");
  });

  it("stores credentials after authenticate", async () => {
    const mgr = new AuthManager();
    mgr.registerProvider(new ApiKeyFlow("sk-test"));
    await mgr.authenticate("api-key");
    const stored = mgr.getCredentials("api-key");
    expect(stored).toBeDefined();
    expect(stored!.accessToken).toBe("sk-test");
  });

  it("getCredentials returns undefined before authenticate", () => {
    const mgr = new AuthManager();
    expect(mgr.getCredentials("api-key")).toBeUndefined();
  });

  it("last registered provider wins for same name", async () => {
    const mgr = new AuthManager();
    mgr.registerProvider(new ApiKeyFlow("first"));
    mgr.registerProvider(new ApiKeyFlow("second"));
    const creds = await mgr.authenticate("api-key");
    expect(creds.accessToken).toBe("second");
  });
});

describe("CredentialStorage", () => {
  let tempDir: string;
  let storage: CredentialStorage;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "oh-test-creds-"));
    storage = new CredentialStorage(join(tempDir, "credentials.json"));
  });

  afterEach(() => {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
  });

  it("stores and loads a credential", async () => {
    await storage.storeApiKey("anthropic", "sk-ant-test123");
    const key = await storage.loadApiKey("anthropic");
    expect(key).toBe("sk-ant-test123");
  });

  it("returns undefined for missing provider", async () => {
    const key = await storage.loadApiKey("nonexistent");
    expect(key).toBeUndefined();
  });

  it("lists stored providers", async () => {
    await storage.storeApiKey("anthropic", "sk-ant-1");
    await storage.storeApiKey("deepseek", "sk-ds-1");
    const providers = await storage.listStoredProviders();
    expect(providers).toContain("anthropic");
    expect(providers).toContain("deepseek");
    expect(providers.length).toBe(2);
  });

  it("clears provider credentials", async () => {
    await storage.storeApiKey("anthropic", "sk-ant-1");
    await storage.storeApiKey("deepseek", "sk-ds-1");
    await storage.clearProviderCredentials("anthropic");
    const key = await storage.loadApiKey("anthropic");
    expect(key).toBeUndefined();
    const dsKey = await storage.loadApiKey("deepseek");
    expect(dsKey).toBe("sk-ds-1");
  });

  it("handles clear for non-existent provider gracefully", async () => {
    await expect(storage.clearProviderCredentials("nope")).resolves.toBeUndefined();
  });

  it("overwrites existing key", async () => {
    await storage.storeApiKey("anthropic", "old-key");
    await storage.storeApiKey("anthropic", "new-key");
    const key = await storage.loadApiKey("anthropic");
    expect(key).toBe("new-key");
  });

  it("stores arbitrary credential keys", async () => {
    await storage.storeCredential("custom", "token", "abc123");
    const val = await storage.loadCredential("custom", "token");
    expect(val).toBe("abc123");
  });

  it("returns empty list when no credentials stored", async () => {
    const providers = await storage.listStoredProviders();
    expect(providers).toEqual([]);
  });

  it("does not wipe keys written by another CredentialStorage on the same file", async () => {
    const path = join(tempDir, "credentials.json");
    const warmed = new CredentialStorage(path);
    const other = new CredentialStorage(path);

    await warmed.storeApiKey("anthropic", "sk-ant");
    await warmed.listStoredProviders(); // warm in-memory cache
    await other.storeApiKey("custom", "sk-custom");
    await warmed.storeApiKey("openai", "sk-openai");

    expect(await warmed.loadApiKey("anthropic")).toBe("sk-ant");
    expect(await warmed.loadApiKey("custom")).toBe("sk-custom");
    expect(await warmed.loadApiKey("openai")).toBe("sk-openai");
    expect(await other.loadApiKey("custom")).toBe("sk-custom");
  });

  it("clear on a stale instance keeps credentials written by another instance", async () => {
    const path = join(tempDir, "credentials.json");
    const warmed = new CredentialStorage(path);
    const other = new CredentialStorage(path);

    await warmed.storeApiKey("anthropic", "sk-ant");
    await warmed.listStoredProviders();
    await other.storeApiKey("custom", "sk-custom");
    await warmed.clearProviderCredentials("anthropic");

    expect(await warmed.loadApiKey("anthropic")).toBeUndefined();
    expect(await warmed.loadApiKey("custom")).toBe("sk-custom");
  });
});

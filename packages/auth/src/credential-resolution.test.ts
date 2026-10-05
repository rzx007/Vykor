import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Settings } from "@vykor/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CredentialStorage } from "./credential-storage.js";
import { resolveApiKey } from "./credential-resolution.js";

const BASE_SETTINGS: Settings = {
  model: "claude-sonnet-4-20250514",
  apiFormat: "anthropic",
  maxTurns: 50,
  permission: { mode: "default" },
};

describe("resolveApiKey", () => {
  let tempDir: string;
  let storage: CredentialStorage;
  const envKeys = [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "DEEPSEEK_API_KEY",
    "CODEX_HOME",
  ];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of envKeys) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    tempDir = mkdtempSync(join(tmpdir(), "oh-test-auth-"));
    storage = new CredentialStorage(join(tempDir, "credentials.json"));
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (saved[key] !== undefined) process.env[key] = saved[key];
      else delete process.env[key];
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("resolves explicit, stored, detected, and environment credentials in order", async () => {
    await storage.storeApiKey("anthropic", "sk-stored");
    process.env.ANTHROPIC_API_KEY = "sk-env";

    await expect(resolveApiKey(BASE_SETTINGS, { apiKey: "sk-explicit" }, storage))
      .resolves.toBe("sk-explicit");
    await expect(resolveApiKey(BASE_SETTINGS, {}, storage)).resolves.toBe("sk-stored");
    await expect(resolveApiKey(BASE_SETTINGS, {}, new CredentialStorage(join(tempDir, "empty.json"))))
      .resolves.toBe("sk-env");
  });

  it("uses the configured or model-detected provider without borrowing another provider key", async () => {
    await storage.storeApiKey("deepseek", "sk-deepseek");

    await expect(resolveApiKey(BASE_SETTINGS, {}, storage)).resolves.toBe("");
    await expect(resolveApiKey(BASE_SETTINGS, { model: "deepseek-v4-flash" }, storage))
      .resolves.toBe("sk-deepseek");
  });

  it("does not send another provider's key to a named custom provider endpoint", async () => {
    await storage.storeApiKey("openai", "sk-openai-secret");
    process.env.OPENAI_API_KEY = "sk-openai-env";
    process.env.ANTHROPIC_API_KEY = "sk-anthropic-env";

    const customSettings: Settings = {
      ...BASE_SETTINGS,
      provider: "office-gateway",
      model: "gpt-4o",
      apiFormat: "openai",
      baseUrl: "https://evil.example/v1",
      apiKey: "sk-settings-from-env",
      customProviders: [{
        id: "office-gateway",
        displayName: "Office Gateway",
        baseUrl: "https://evil.example/v1",
        apiFormat: "openai",
        models: [{ id: "gpt-4o", displayName: "GPT-4o" }],
      }],
    };

    await expect(resolveApiKey(customSettings, {
      provider: "office-gateway",
      model: "gpt-4o",
      baseUrl: "https://evil.example/v1",
    }, storage)).resolves.toBe("");

    await storage.storeApiKey("office-gateway", "sk-custom-only");
    await expect(resolveApiKey(customSettings, {
      provider: "office-gateway",
      model: "gpt-4o",
      baseUrl: "https://evil.example/v1",
    }, storage)).resolves.toBe("sk-custom-only");

    await expect(resolveApiKey(customSettings, {
      provider: "office-gateway",
      model: "gpt-4o",
      apiKey: "sk-call-site",
    }, storage)).resolves.toBe("sk-call-site");
  });

  it("still allows settings.apiKey as a last resort for a named built-in provider", async () => {
    await expect(resolveApiKey(
      { ...BASE_SETTINGS, provider: "openai", apiKey: "sk-settings-openai" },
      { provider: "openai", model: "gpt-4o" },
      storage,
    )).resolves.toBe("sk-settings-openai");
  });

  it("uses a programmatic base URL override when selecting stored credentials", async () => {
    await storage.storeApiKey("aihubmix", "sk-aihubmix");

    await expect(resolveApiKey(BASE_SETTINGS, {
      baseUrl: "https://aihubmix.com/v1",
    }, storage)).resolves.toBe("sk-aihubmix");
  });

  it("loads the Codex subscription token", async () => {
    const token = makeJwt({
      exp: Math.floor(Date.now() / 1000) + 3600,
      "https://api.openai.com/auth": { chatgpt_account_id: "acct_123" },
    });
    writeFileSync(join(tempDir, "auth.json"), JSON.stringify({
      tokens: { access_token: token },
    }));
    process.env.CODEX_HOME = tempDir;

    await expect(resolveApiKey(
      { ...BASE_SETTINGS, provider: "codex", model: "gpt-5.4" },
      {},
      storage,
    )).resolves.toBe(token);
  });
});

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.sig`;
}

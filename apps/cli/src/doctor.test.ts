import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CredentialStorage } from "@vykor/auth";
import type { Settings } from "@vykor/core";
import { checkApiKey } from "./doctor";

function mkSettings(partial: Partial<Settings>): Settings {
  return {
    model: "unknown-model-xyz",
    apiFormat: "openai",
    maxTurns: 50,
    permission: { mode: "default" },
    memory: { enabled: true, maxFiles: 5, maxEntrypointLines: 200 },
    effort: "medium",
    passes: 1,
    ...partial,
  } as Settings;
}

describe("checkApiKey", () => {
  let dir: string;
  let credsPath: string;
  const savedEnv: Record<string, string | undefined> = {};
  const envKeys = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "DEEPSEEK_API_KEY", "OPENROUTER_API_KEY"];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "oh-doctor-"));
    credsPath = join(dir, "credentials.json");
    for (const k of envKeys) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(async () => {
    for (const k of envKeys) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    await rm(dir, { recursive: true, force: true });
  });

  it("finds a provider key stored in credentials.json (the case doctor wrongly reported as not set)", async () => {
    await writeFile(credsPath, JSON.stringify({ deepseek: { api_key: "sk-deepseek-test" } }), "utf-8");
    const storage = new CredentialStorage(credsPath);
    const result = await checkApiKey(mkSettings({ provider: "deepseek", model: "deepseek-v4-flash" }), storage);
    expect(result.ok).toBe(true);
    expect(result.source).toBe("credentials.json [deepseek]");
  });

  it("reports an explicit settings.apiKey as the source", async () => {
    await writeFile(credsPath, "{}", "utf-8");
    const storage = new CredentialStorage(credsPath);
    const result = await checkApiKey(mkSettings({ apiKey: "sk-inline" }), storage);
    expect(result.ok).toBe(true);
    expect(result.source).toBe("settings.json");
  });

  it("detects a key by model-derived provider when no provider is set", async () => {
    await writeFile(credsPath, JSON.stringify({ deepseek: { api_key: "sk-deepseek-test" } }), "utf-8");
    const storage = new CredentialStorage(credsPath);
    // no explicit provider; model "deepseek-chat" should resolve to the deepseek provider
    const result = await checkApiKey(mkSettings({ model: "deepseek-chat" }), storage);
    expect(result.ok).toBe(true);
    expect(result.source).toBe("credentials.json [deepseek]");
  });

  it("returns not set when no key is configured anywhere", async () => {
    await writeFile(credsPath, "{}", "utf-8");
    const storage = new CredentialStorage(credsPath);
    const result = await checkApiKey(mkSettings({ model: "unknown-model-xyz" }), storage);
    expect(result.ok).toBe(false);
    expect(result.source).toBe("not set");
  });
});

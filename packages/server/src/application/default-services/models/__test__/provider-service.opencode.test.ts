import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CredentialStorage } from "@vykor/auth";
import { saveSettings, type Settings } from "@vykor/host-config";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDefaultProviderService } from "../provider-service.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "vykor-opencode-provider-"));
  vi.stubEnv("VYKOR_CONFIG_DIR", root);
  const catalogPath = join(root, "models.json");
  await writeFile(catalogPath, JSON.stringify({
    "opencode-go": {
      name: "OpenCode Go",
      env: ["OPENCODE_API_KEY"],
      api: "https://opencode.ai/inference/go/openai/v1",
      npm: "@ai-sdk/openai-compatible",
      models: { "kimi-k3": { name: "Kimi K3" } },
    },
  }));
  vi.stubEnv("VYKOR_MODELS_PATH", catalogPath);
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url !== "https://opencode.ai/inference/go/v1/models") {
      return new Response(null, { status: 404 });
    }
    if (new Headers(init?.headers).get("authorization") !== "Bearer new-key") {
      return new Response("invalid credential", { status: 401 });
    }
    return Response.json({ data: [{ id: "kimi-k3" }] });
  }));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

async function setup(connected: boolean) {
  const ref = {
    current: {
      model: "kimi-k3",
      provider: connected ? "opencode-go" : "openai",
      apiFormat: "openai",
      maxTurns: 50,
      permission: { mode: "default" },
      ...(connected ? {
        customProviders: [{
          id: "opencode-go",
          displayName: "OpenCode Go",
          baseUrl: "https://opencode.ai/inference/go/openai/v1",
          apiFormat: "openai",
          source: "models.dev",
          models: [{ id: "kimi-k3", displayName: "Kimi K3" }],
          headers: { "x-opencode-session": "{{sessionId}}", "X-Tenant": "personal" },
        }],
      } : {}),
    } as Settings,
  };
  await saveSettings(ref.current);
  if (connected) await new CredentialStorage().storeApiKey("opencode-go", "old-key");
  return { ref, service: createDefaultProviderService(ref) };
}

describe("OpenCode Go credentials", () => {
  it.each([false, true])("saves a validated key (already connected: %s)", async (connected) => {
    const { ref, service } = await setup(connected);

    await expect(service.connectCatalog!("opencode-go", { apiKey: " new-key " })).resolves.toMatchObject({
      name: "opencode-go",
      hasKey: true,
      source: "catalog",
    });

    expect(await new CredentialStorage().loadApiKey("opencode-go")).toBe("new-key");
    expect(ref.current.customProviders).toHaveLength(1);
    expect(ref.current.customProviders?.[0]).toMatchObject({
      baseUrl: "https://opencode.ai/inference/go/openai/v1",
      source: "models.dev",
    });
    expect(ref.current.provider).toBe(connected ? "opencode-go" : "openai");
    expect(ref.current.model).toBe("kimi-k3");
    if (connected) {
      expect(ref.current.customProviders?.[0]?.headers).toEqual({
        "x-opencode-session": "{{sessionId}}",
        "X-Tenant": "personal",
      });
    }
    expect(await readFile(join(root, "settings.json"), "utf8")).not.toContain("new-key");
  });

  it("keeps the previous key and settings when the new key is rejected", async () => {
    const { ref, service } = await setup(true);
    const settingsBefore = await readFile(join(root, "settings.json"), "utf8");
    const providersBefore = structuredClone(ref.current.customProviders);

    await expect(service.connectCatalog!("opencode-go", { apiKey: "bad-key" }))
      .rejects.toThrow("API 密钥无效");

    expect(await new CredentialStorage().loadApiKey("opencode-go")).toBe("old-key");
    expect(await readFile(join(root, "settings.json"), "utf8")).toBe(settingsBefore);
    expect(ref.current.customProviders).toEqual(providersBefore);
  });
});

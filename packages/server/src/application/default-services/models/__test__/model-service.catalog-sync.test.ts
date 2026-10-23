import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createModelCatalogService } from "@vykor/api";
import { CredentialStorage } from "@vykor/auth";
import { saveSettings, type Settings } from "@vykor/host-config";
import { createDefaultModelService } from "../model-service.js";
import { createDefaultSettingsService } from "../../configuration/settings-service.js";
import { validateRequestSelection } from "../../../session/interactions/request-selection-validation.js";

vi.mock("@vykor/auth", async original => ({
  ...await original<typeof import("@vykor/auth")>(),
  describeCodexAuthState: async () => ({ configured: false }),
}));

let root: string;
let modelId: string;
let ref: { current: Settings };
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "vykor-model-sync-"));
  vi.stubEnv("VYKOR_CONFIG_DIR", root);
  vi.stubEnv("VYKOR_MODELS_PATH", "");
  vi.stubEnv("VYKOR_DISABLE_MODELS_FETCH", "");
  modelId = "fresh";
  ref = { current: {
    model: "saved", provider: "remote", apiFormat: "openai", maxTurns: 50,
    permission: { mode: "default" },
    customProviders: [{
      id: "remote", displayName: "Remote", baseUrl: "https://remote.example/v1",
      source: "models.dev", apiFormat: "openai", models: [{ id: "saved", displayName: "Saved" }],
      headers: { "X-Tenant": "personal" },
    }],
  } };
  await saveSettings(ref.current);
  await new CredentialStorage().storeApiKey("remote", "fixture-key");
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({
    remote: {
      name: "Remote", api: "https://remote.example/v1", env: ["REMOTE_API_KEY"],
      npm: "@ai-sdk/openai-compatible",
      models: {
        [modelId]: { id: modelId, name: "Latest Model", limit: { context: 200_000 }, modalities: { input: ["text", "image"] } },
        retired: { status: "deprecated" }, preview: { status: "alpha" },
      },
    },
  })));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await rm(root, { recursive: true, force: true });
});

describe("connected catalog model synchronization", () => {
  it("uses the latest selectable models without changing credentials or user settings", async () => {
    const saved = await readFile(join(root, "settings.json"), "utf8");
    const providers = await createDefaultModelService(ref).list();
    expect(providers.find(provider => provider.name === "remote")?.models).toEqual([
      expect.objectContaining({ id: "fresh", label: "Latest Model", contextWindow: 200_000, vision: true }),
    ]);
    expect(await readFile(join(root, "settings.json"), "utf8")).toBe(saved);
    expect(await new CredentialStorage().loadApiKey("remote")).toBe("fixture-key");
    expect(() => validateRequestSelection({
      catalog: { remote: { models: { fresh: {} } } }, customProviders: ref.current.customProviders,
      provider: "remote", model: "saved", effort: undefined, explicitEffort: false,
    })).toThrow("not available");
  });

  it("refreshes the current model list and lets the new model be selected for a conversation or default", async () => {
    const models = createDefaultModelService(ref);
    await models.list();
    modelId = "newer";
    const providers = await models.list({ refresh: true });
    expect(providers.find(provider => provider.name === "remote")?.models.map(model => model.id)).toEqual(["newer"]);
    const catalog = await createModelCatalogService().load();
    expect(() => validateRequestSelection({
      catalog, customProviders: ref.current.customProviders, provider: "remote",
      model: "newer", effort: undefined, explicitEffort: false,
    })).not.toThrow();
    await expect(createDefaultSettingsService(ref).patch({ provider: "remote", model: "newer" }))
      .resolves.toMatchObject({ settings: { model: "newer" } });
  });

  it("leaves hand-configured provider models under user control", async () => {
    delete ref.current.customProviders![0]!.source;
    const providers = await createDefaultModelService(ref).list();
    expect(providers.find(provider => provider.name === "remote")?.models.map(model => model.id)).toEqual(["saved"]);
  });

  it("falls back to the stored models when the provider is missing from the available catalog", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ other: { models: { other: {} } } })));
    const providers = await createDefaultModelService(ref).list();
    expect(providers.find(provider => provider.name === "remote")?.models.map(model => model.id)).toEqual(["saved"]);
  });
});

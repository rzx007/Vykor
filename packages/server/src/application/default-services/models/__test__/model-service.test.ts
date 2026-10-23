import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CredentialStorage } from "@vykor/auth";
import { createDefaultModelService } from "../model-service.js";
import { createDefaultAuthService } from "../../configuration/auth-service.js";

vi.mock("@vykor/api", async (importOriginal) => ({
  ...await importOriginal<typeof import("@vykor/api")>(),
  createModelCatalogService: () => ({ load: async () => ({
    deepseek: { models: { "deepseek-chat": { id: "deepseek-chat", name: "DeepSeek Chat" } } },
  }) }),
}));
vi.mock("@vykor/auth", async (importOriginal) => ({
  ...await importOriginal<typeof import("@vykor/auth")>(),
  describeCodexAuthState: async () => ({ configured: false }),
}));

describe("model list credential freshness", () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "vykor-model-freshness-"));
    vi.stubEnv("VYKOR_CONFIG_DIR", directory);
    vi.stubEnv("DEEPSEEK_API_KEY", "");
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });

  it("removes disconnected provider models without recreating the model service", async () => {
    await new CredentialStorage().storeApiKey("deepseek", "test-key");
    const models = createDefaultModelService();
    expect((await models.list()).map(provider => provider.name)).toContain("deepseek");
    await createDefaultAuthService().logout({ provider: "deepseek" });
    expect((await models.list()).map(provider => provider.name)).not.toContain("deepseek");
  });

  it("sees newly connected and reconnected providers on the next list request", async () => {
    const models = createDefaultModelService();
    expect((await models.list()).map(provider => provider.name)).not.toContain("deepseek");
    await new CredentialStorage().storeApiKey("deepseek", "first-key");
    expect((await models.list()).map(provider => provider.name)).toContain("deepseek");
    await new CredentialStorage().clearProviderCredentials("deepseek");
    expect((await models.list()).map(provider => provider.name)).not.toContain("deepseek");
    await new CredentialStorage().storeApiKey("deepseek", "second-key");
    expect((await models.list()).map(provider => provider.name)).toContain("deepseek");
  });

  it("keeps environment-authenticated models after stored credentials are removed", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "environment-key");
    await new CredentialStorage().storeApiKey("deepseek", "stored-key");
    const models = createDefaultModelService();
    await models.list();
    await new CredentialStorage().clearProviderCredentials("deepseek");
    expect((await models.list()).map(provider => provider.name)).toContain("deepseek");
  });
});

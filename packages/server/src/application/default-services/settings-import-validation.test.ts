import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getConfigFilePath, loadSettings, updateSettings } from "@vykor/core";
import { exportPortableSettings } from "../../settings-transfer.js";

const probes = vi.hoisted(() => ({ catalog: vi.fn(async () => ({})), environment: vi.fn(async (config: { shell?: { executable: string } }) => {
  if (config.shell?.executable === "/missing/shell") throw new Error("Shell 不可启动");
}) }));
vi.mock("../../runtime/runtime-settings.js", () => ({ validateRuntimeEnvironmentConfig: probes.environment }));
vi.mock("@vykor/api", async importOriginal => ({ ...await importOriginal<Record<string, unknown>>(), createModelCatalogService: () => ({ load: probes.catalog }) }));
import { createDefaultSettingsService } from "./settings-service.js";

let directory = "";
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "settings-import-validation-"));
  vi.stubEnv("VYKOR_CONFIG_DIR", directory); probes.environment.mockClear(); probes.catalog.mockClear();
  await updateSettings(current => ({ ...current, provider: "gateway", model: "chat", customProviders: [{ id: "gateway", displayName: "Gateway", baseUrl: "http://localhost/v1", apiFormat: "openai", models: [{ id: "chat", displayName: "Chat" }] }] }), { includeEnvironment: false });
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });
async function service() {
  return createDefaultSettingsService({ current: await loadSettings(), reload: () => loadSettings() });
}
async function importGroups(groups: Record<string, unknown>, categories = Object.keys(groups)) {
  return (await service()).patch({ importConfiguration: { value: { version: 1, groups }, categories, expected: await exportPortableSettings() } });
}
describe("portable import validates real execution targets before any write", () => {
  it("leaves every selected category intact when a configured shell cannot start", async () => {
    const before = readFileSync(getConfigFilePath(), "utf8");
    await expect(importGroups({ general: { showReasoning: false }, environment: { agentEnvironment: { kind: "native", shell: { executable: "/missing/shell", args: [] } } } })).rejects.toThrow(/Shell/);
    expect(readFileSync(getConfigFilePath(), "utf8")).toBe(before);
  });
  it("does not probe an environment category the user excluded", async () => {
    await importGroups({ general: { showReasoning: false }, environment: { agentEnvironment: { kind: "native", shell: { executable: "/missing/shell", args: [] } } } }, ["general"]);
    expect((await loadSettings(undefined, { includeEnvironment: false })).showReasoning).toBe(false);
    expect(probes.environment).not.toHaveBeenCalled();
  });
  it.each([{ provider: "gateway", model: "unknown" }, { provider: "unknown", model: "chat" }])("rejects unavailable provider/model %s without importing unrelated preferences", async model => {
    const before = readFileSync(getConfigFilePath(), "utf8");
    await expect(importGroups({ general: { showReasoning: false }, model })).rejects.toThrow(/模型|供应商|Model/);
    expect(readFileSync(getConfigFilePath(), "utf8")).toBe(before);
  });
  it("rejects an explicit reasoning effort whose model capability is unknown", async () => {
    const before = readFileSync(getConfigFilePath(), "utf8");
    await expect(importGroups({ model: { provider: "gateway", model: "chat", effort: "high" } })).rejects.toThrow(/Effort/);
    expect(readFileSync(getConfigFilePath(), "utf8")).toBe(before);
  });
  it("keeps a valid partial model import disabled when it did not request a new model", async () => {
    await updateSettings(current => ({ ...current, modelDisabled: true }), { includeEnvironment: false });
    await importGroups({ model: { effort: "" } });
    expect((await loadSettings(undefined, { includeEnvironment: false })).modelDisabled).toBe(true);
  });
  it("imports a valid configured provider/model pair and keeps launch overrides effective", async () => {
    vi.stubEnv("VYKOR_MODEL", "launch-model");
    const result = await importGroups({ model: { provider: "gateway", model: "chat", effort: "" } });
    expect((await loadSettings(undefined, { includeEnvironment: false })).model).toBe("chat");
    expect(result.settings.model).toBe("launch-model");
  });
  it("rejects the entire batch if the CLI changes isolation while environment probing is in progress", async () => {
    let changed = "";
    probes.environment.mockImplementationOnce(async () => {
      await updateSettings(current => ({ ...current, sandbox: { ...current.sandbox, enabled: true } }), { includeEnvironment: false });
      changed = readFileSync(getConfigFilePath(), "utf8");
    });
    await expect(importGroups({ general: { showReasoning: false }, environment: { agentEnvironment: { kind: "native" } } })).rejects.toMatchObject({ code: "settings_conflict", field: "sandbox" });
    expect(readFileSync(getConfigFilePath(), "utf8")).toBe(changed);
  });
  it("rejects the entire batch if provider definitions change during model validation", async () => {
    let changed = "";
    probes.catalog.mockImplementationOnce(async () => {
      await updateSettings(current => ({ ...current, customProviders: current.customProviders?.map(provider => ({ ...provider, models: [] })) }), { includeEnvironment: false });
      changed = readFileSync(getConfigFilePath(), "utf8");
      return {};
    });
    await expect(importGroups({ general: { showReasoning: false }, model: { provider: "gateway", model: "chat", effort: "" } })).rejects.toMatchObject({ code: "settings_conflict", field: "customProviders" });
    expect(readFileSync(getConfigFilePath(), "utf8")).toBe(changed);
  });
});

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDefaultSettingsService, settingsPatchRuntimeImpact } from "./settings-service.js";
import { getConfigFilePath, loadSettings, updateSettings } from "@vykor/core";

let root: string;
let previousConfigDir: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "oh-settings-service-"));
  previousConfigDir = process.env.VYKOR_CONFIG_DIR;
  process.env.VYKOR_CONFIG_DIR = join(root, "config");
});

afterEach(() => {
  vi.unstubAllEnvs();
  if (previousConfigDir === undefined) delete process.env.VYKOR_CONFIG_DIR;
  else process.env.VYKOR_CONFIG_DIR = previousConfigDir;
  rmSync(root, { recursive: true, force: true });
});

describe("durable defaults and launch environment overrides", () => {
  async function productionService() {
    const ref = { current: await loadSettings(), reload: () => loadSettings() };
    return { ref, service: createDefaultSettingsService(ref) };
  }
  it("saves task limits with a file-lock conflict check and never persists read-only metadata", async () => {
    const { service } = await productionService();
    const before = await service.get();
    expect(before.maxTurnsEditable).toBe(true);
    await service.patch({ maxTurns: 75, expectedMaxTurns: 50 });
    expect((await loadSettings(undefined, { includeEnvironment: false })).maxTurns).toBe(75);
    const saved = readFileSync(getConfigFilePath(), "utf8");
    expect(saved).not.toContain("expectedMaxTurns");
    expect(saved).not.toContain("maxTurnsEditable");
    await expect(service.patch({ maxTurns: 90, expectedMaxTurns: 50 })).rejects.toMatchObject({ code: "settings_conflict", field: "maxTurns" });
    expect(readFileSync(getConfigFilePath(), "utf8")).toBe(saved);
  });
  it("blocks desktop task-limit edits when a launch override controls the effective value", async () => {
    await updateSettings(current => ({ ...current, maxTurns: 20 }), { includeEnvironment: false });
    vi.stubEnv("VYKOR_MAX_TURNS", "77");
    const { service } = await productionService();
    expect(await service.get()).toMatchObject({ maxTurns: 77, maxTurnsEditable: false });
    await expect(service.patch({ maxTurns: 30, expectedMaxTurns: 77 })).rejects.toThrow(/启动环境变量/);
    expect((await loadSettings(undefined, { includeEnvironment: false })).maxTurns).toBe(20);
  });
  it.each([0, 1001, 1.5])("rejects invalid desktop task limit %s without writes", async maxTurns => {
    const { service } = await productionService();
    await expect(service.patch({ maxTurns, expectedMaxTurns: 50 })).rejects.toThrow(/1–1000/);
    expect((await loadSettings(undefined, { includeEnvironment: false })).maxTurns).toBe(50);
  });
  it("reloads a runtime marker without writing the launch override into the saved target", async () => {
    await updateSettings(current => ({ ...current, agentEnvironment: { kind: "wsl" } }), { includeEnvironment: false });
    vi.stubEnv("VYKOR_AGENT_ENVIRONMENT", "native");
    const { ref, service } = await productionService();
    const before = readFileSync(getConfigFilePath(), "utf8");
    const result = await service.patch({ runtimeEnvironmentChanged: true });
    expect(readFileSync(getConfigFilePath(), "utf8")).toBe(before);
    expect(result.invalidateRuntimes).toBe(true);
    expect(ref.current.agentEnvironment?.kind).toBe("native");
  });
  it("changes an unrelated preference without persisting environment-only model, URL or limits", async () => {
    await updateSettings(current => ({ ...current, model: "saved-model", baseUrl: "https://saved.example", maxTurns: 20 }), { includeEnvironment: false });
    vi.stubEnv("VYKOR_MODEL", "launched-model"); vi.stubEnv("VYKOR_BASE_URL", "https://launch.example"); vi.stubEnv("VYKOR_MAX_TURNS", "77");
    const { ref, service } = await productionService();
    const result = await service.patch({ showReasoning: false });
    const saved = await loadSettings(undefined, { includeEnvironment: false });
    expect(saved).toMatchObject({ model: "saved-model", baseUrl: "https://saved.example", maxTurns: 20, showReasoning: false });
    expect(ref.current).toMatchObject({ model: "launched-model", baseUrl: "https://launch.example", maxTurns: 77, showReasoning: false });
    expect(result.settings.model).toBe("launched-model");
  });
  it("saves a requested limit while the launch override continues to control the effective value", async () => {
    await updateSettings(current => ({ ...current, maxTurns: 20 }), { includeEnvironment: false });
    vi.stubEnv("VYKOR_MAX_TURNS", "77");
    const { ref, service } = await productionService();
    const result = await service.patch({ maxTurns: 30 });
    expect((await loadSettings(undefined, { includeEnvironment: false })).maxTurns).toBe(30);
    expect(ref.current.maxTurns).toBe(77);
    expect(result.settings.maxTurns).toBe(77);
  });
});

function createSettingsService() {
  return createDefaultSettingsService({
    current: {
      model: "m",
      apiFormat: "anthropic",
      maxTurns: 50,
      permission: { mode: "default" },
    },
  });
}

describe("settings service config coercion", () => {
  it("coerces the showReasoning config value to a boolean", async () => {
    const service = createSettingsService();
    const result = await service.patch({ path: "showReasoning", value: "off" });
    expect(result.settings.showReasoning).toBe(false);
  });
});

describe("settings runtime impact", () => {
  it("invalidates future tasks when permission rules or isolation change", () => {
    expect(settingsPatchRuntimeImpact({ permission: { mode: "plan" } })).toBe("invalidate");
    expect(settingsPatchRuntimeImpact({ sandbox: { enabled: false } })).toBe("invalidate");
  });
  it("invalidates warm agents when outputTokenMax changes", () => {
    expect(settingsPatchRuntimeImpact({ path: "outputTokenMax", value: 16_000 })).toBe("invalidate");
  });

  it("invalidates warm agents when custom instructions or memory availability changes", () => {
    expect(settingsPatchRuntimeImpact({ systemPrompt: "new instruction" })).toBe("invalidate");
    expect(settingsPatchRuntimeImpact({ memory: { enabled: false } })).toBe("invalidate");
  });
});

describe("permission settings persistence", () => {
  it("rejects a stale completion-review mode inside the settings file lock", async () => {
    const service = createSettingsService();
    await updateSettings(current => ({ ...current, autoReview: { mode: "risk_based" } }), { includeEnvironment: false });
    const before = readFileSync(getConfigFilePath(), "utf8");
    await expect(service.patch({ autoReview: { mode: "off" }, expectedAutoReviewMode: "off" })).rejects.toMatchObject({ code: "settings_conflict", field: "autoReview" });
    expect(readFileSync(getConfigFilePath(), "utf8")).toBe(before);
  });
  it("checks concurrent changes inside the shared settings file lock", async () => {
    const service = createSettingsService();
    await updateSettings(current => ({ ...current, permission: { mode: "plan" } }));
    await expect(service.patch({ expectedPermission: { mode: "default" }, permission: { mode: "full_auto" } })).rejects.toMatchObject({ code: "settings_conflict" });
  });
  it("rejects invalid rules without changing persisted settings", async () => {
    const service = createSettingsService();
    await expect(service.patch({ permission: { deniedTools: "Read" } })).rejects.toThrow();
    expect((await service.get()).permission).toEqual({ mode: "default" });
  });
  it("merges a mode change without discarding existing restrictions", async () => {
    const service = createSettingsService();
    await service.patch({ permission: { deniedTools: ["Shell"] } });
    const result = await service.patch({ permission: { mode: "full_auto" } });
    expect(result.settings.permission).toEqual({ mode: "full_auto", deniedTools: ["Shell"] });
  });
});

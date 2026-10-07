import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDefaultSettingsService, settingsPatchRuntimeImpact } from "./settings-service.js";
import { updateSettings } from "@vykor/core";

let root: string;
let previousConfigDir: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "oh-settings-service-"));
  previousConfigDir = process.env.VYKOR_CONFIG_DIR;
  process.env.VYKOR_CONFIG_DIR = join(root, "config");
});

afterEach(() => {
  if (previousConfigDir === undefined) delete process.env.VYKOR_CONFIG_DIR;
  else process.env.VYKOR_CONFIG_DIR = previousConfigDir;
  rmSync(root, { recursive: true, force: true });
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

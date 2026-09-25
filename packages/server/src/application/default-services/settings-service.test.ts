import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDefaultSettingsService, settingsPatchRuntimeImpact } from "./settings-service.js";

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
  it("invalidates warm agents when outputTokenMax changes", () => {
    expect(settingsPatchRuntimeImpact({ path: "outputTokenMax", value: 16_000 })).toBe("invalidate");
  });
});

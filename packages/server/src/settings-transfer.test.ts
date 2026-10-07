import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSettings, SettingsConflictError, updateSettings } from "@vykor/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exportPortableSettings, importPortableSettings, parsePortableSettings } from "./settings-transfer.js";

let directory = "";
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "vk-settings-transfer-"));
  vi.stubEnv("VYKOR_CONFIG_DIR", directory);
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });

describe("portable settings boundaries", () => {
  it.each([
    { version: 1, groups: {}, apiKey: "fixture-secret" },
    { version: 1, groups: { credentials: { apiKey: "fixture-secret" } } },
    { version: 1, groups: { model: { apiKey: "fixture-secret" } } },
    { version: 1, groups: { model: { secretHeaders: { Authorization: "fixture-secret" } } } },
    { version: 1, groups: { general: { unexpected: true } } },
    { version: 1, groups: { model: { model: "" } } },
    { version: 1, groups: { model: { provider: "   " } } },
    { version: 1, groups: { environment: { agentEnvironment: { kind: "native", env: {} } } } },
    { version: 1, groups: { environment: { agentEnvironment: { kind: "native", secretEnv: [] } } } },
    { version: 1, groups: { environment: { agentEnvironment: { kind: "native", secretHeaders: {} } } } },
    { version: 1, groups: { memory: { memory: { apiKey: "fixture-secret" } } } },
  ])("rejects secrets and unknown input fields: %j", (value) => {
    expect(() => parsePortableSettings(value)).toThrow();
  });

  it("exports durable values without startup overrides, environment values, or secret references", async () => {
    await updateSettings((current) => ({ ...current, model: "file-model", provider: "openai", agentEnvironment: {
      kind: "native", shell: { executable: "configured-shell", args: ["--profile", "two words"] },
      env: { MODE: "private-normal-value" }, secretEnv: ["PRIVATE_TOKEN"],
    } }), { includeEnvironment: false });
    vi.stubEnv("VYKOR_MODEL", "startup-model");
    vi.stubEnv("OPENAI_API_KEY", "startup-api-secret");
    const portable = await exportPortableSettings();
    expect(portable.groups.model).toMatchObject({ model: "file-model", provider: "openai" });
    expect(portable.groups.environment).toEqual({ agentEnvironment: { kind: "native", shell: { executable: "configured-shell", args: ["--profile", "two words"] } } });
    const encoded = JSON.stringify(portable);
    for (const excluded of ["startup-model", "startup-api-secret", "private-normal-value", "PRIVATE_TOKEN"]) expect(encoded).not.toContain(excluded);
    expect(() => parsePortableSettings(portable)).not.toThrow();
  });

  it("imports selected ordinary values while preserving environment values and secret references", async () => {
    await updateSettings((current) => ({ ...current, workStyle: "practical", showReasoning: true,
      model: "file-model", modelDisabled: true,
      agentEnvironment: { kind: "native", env: { MODE: "keep-value" }, secretEnv: ["TOKEN"] },
    }), { includeEnvironment: false });
    const expected = await exportPortableSettings();
    vi.stubEnv("VYKOR_MODEL", "startup-model");
    await importPortableSettings({ version: 1, groups: {
      general: { workStyle: "efficient", showReasoning: false },
      model: { model: "imported-model" },
      environment: { agentEnvironment: { kind: "native", shell: { executable: "new-shell", args: ["arg one"] } } },
    } }, ["general", "model", "environment"], expected);
    expect(await loadSettings(undefined, { includeEnvironment: false })).toMatchObject({
      workStyle: "efficient", showReasoning: false, model: "imported-model", modelDisabled: false,
      agentEnvironment: { kind: "native", shell: { executable: "new-shell", args: ["arg one"] }, env: { MODE: "keep-value" }, secretEnv: ["TOKEN"] },
    });
    expect(await readFile(join(directory, "settings.json"), "utf8")).not.toContain("startup-model");
  });

  it("rejects a later-group conflict without saving earlier groups or overwriting the concurrent edit", async () => {
    await updateSettings((current) => ({ ...current, workStyle: "practical", model: "initial-model" }), { includeEnvironment: false });
    const expected = await exportPortableSettings();
    await updateSettings((current) => ({ ...current, model: "concurrent-model" }), { includeEnvironment: false });
    const before = await readFile(join(directory, "settings.json"), "utf8");
    await expect(importPortableSettings({ version: 1, groups: { general: { workStyle: "efficient" }, model: { model: "imported-model" } } }, ["general", "model"], expected)).rejects.toBeInstanceOf(SettingsConflictError);
    expect(await readFile(join(directory, "settings.json"), "utf8")).toBe(before);
  });

  it("lets only one concurrent import with the same baseline commit", async () => {
    await updateSettings((current) => ({ ...current, workStyle: "practical" }), { includeEnvironment: false });
    const expected = await exportPortableSettings();
    const portable = { version: 1, groups: { general: { workStyle: "efficient" } } };
    const results = await Promise.allSettled([
      importPortableSettings(portable, ["general"], expected),
      importPortableSettings(portable, ["general"], expected),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect((await loadSettings(undefined, { includeEnvironment: false })).workStyle).toBe("efficient");
  });
});

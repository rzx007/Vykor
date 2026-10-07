import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProjectSettings, loadSettings, saveProjectSettings, SettingsConflictError, updateSettings, type AgentEnvironmentSettings } from "@vykor/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inspectRuntimeEnvironment, saveRuntimeEnvironment } from "./runtime-settings.js";
import { loadRuntimeSecrets, saveRuntimeSecrets } from "./runtime-secrets.js";

let directory = "";
let project = "";
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "vk-runtime-settings-"));
  project = join(directory, "project");
  await mkdir(project);
  vi.stubEnv("VYKOR_CONFIG_DIR", join(directory, "config"));
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });

describe("runtime scopes and effective startup state", () => {
  it("requires a real stored secret even when its name matches Object.prototype", async () => {
    const snapshot = await inspectRuntimeEnvironment();
    await expect(saveRuntimeEnvironment({ config: { kind: "native", secretEnv: ["constructor"] }, expected: snapshot.userConfig })).rejects.toThrow(/尚未配置/);
  });
  it("merges project overrides into the actual startup defaults and reports kind overrides as startup sources", async () => {
    const user: AgentEnvironmentSettings = { kind: "native", env: { SHARED: "saved-new", USER_ONLY: "user" }, secretEnv: ["USER_TOKEN"] };
    await updateSettings((current) => ({ ...current, agentEnvironment: user }), { includeEnvironment: false });
    await saveProjectSettings({ agentEnvironment: { kind: "native", env: { SHARED: "project", PROJECT_ONLY: "project" }, secretEnv: ["PROJECT_TOKEN"] } }, project);
    const active: AgentEnvironmentSettings = { kind: "wsl", distribution: "Ubuntu", env: { SHARED: "active-old", ACTIVE_ONLY: "active" }, secretEnv: ["ACTIVE_TOKEN"] };
    const saved = await inspectRuntimeEnvironment({ cwd: project, activeDefault: active });
    expect(saved).toMatchObject({ userConfig: user, activeDefault: active, source: "当前项目", restartRequired: true,
      effective: { kind: "native", env: { SHARED: "project", ACTIVE_ONLY: "active", PROJECT_ONLY: "project" }, secretEnv: ["ACTIVE_TOKEN", "PROJECT_TOKEN"] } });
    expect(saved.effective.env).not.toHaveProperty("USER_ONLY");
    const forced = await inspectRuntimeEnvironment({ cwd: project, activeDefault: active, kindOverride: "wsl" });
    expect(forced).toMatchObject({ source: "启动环境变量覆盖", restartRequired: true, effective: { kind: "wsl" } });
    expect(forced.projectConfig?.kind).toBe("native");
  });

  it("preserves unrelated project settings and restores inheritance by removing its override", async () => {
    await updateSettings((current) => ({ ...current, agentEnvironment: { kind: "native", env: { MODE: "user" } } }), { includeEnvironment: false });
    await saveProjectSettings({ systemPrompt: "keep project rules" }, project);
    await saveRuntimeEnvironment({ cwd: project, config: { kind: "native", env: { MODE: "project" } }, expected: null });
    expect((await inspectRuntimeEnvironment({ cwd: project })).effective.env?.MODE).toBe("project");
    const configured = (await loadProjectSettings(project))!.agentEnvironment!;
    await saveRuntimeEnvironment({ cwd: project, config: null, expected: configured });
    expect(await loadProjectSettings(project)).toEqual({ systemPrompt: "keep project rules" });
    expect((await inspectRuntimeEnvironment({ cwd: project })).effective.env?.MODE).toBe("user");
  });

  it("rejects stale scope edits before changing either saved config or scoped secret values", async () => {
    await saveRuntimeSecrets(project, { TOKEN: "project-before" });
    const original: AgentEnvironmentSettings = { kind: "native", env: { MODE: "before" }, secretEnv: ["TOKEN"] };
    await saveProjectSettings({ agentEnvironment: original }, project);
    const before = await readFile(join(project, ".vykor", "settings.json"), "utf8");
    const secretRevision = (await inspectRuntimeEnvironment({ cwd: project })).secretRevision;
    await expect(saveRuntimeEnvironment({ cwd: project, config: { ...original, env: { MODE: "after" } }, expected: null, secrets: { TOKEN: "project-after" }, expectedSecretRevision: secretRevision })).rejects.toBeInstanceOf(SettingsConflictError);
    expect(await readFile(join(project, ".vykor", "settings.json"), "utf8")).toBe(before);
    expect(await loadRuntimeSecrets(project, ["TOKEN"])).toEqual({ TOKEN: "project-before" });
  });

  it("commits a concurrent user-config and secret edit as one consistent winning pair", async () => {
    await saveRuntimeSecrets("global", { TOKEN: "initial-secret" });
    await updateSettings((current) => ({ ...current, agentEnvironment: { kind: "native", env: { MODE: "initial" }, secretEnv: ["TOKEN"] } }), { includeEnvironment: false });
    const snapshot = await inspectRuntimeEnvironment();
    const expected = snapshot.userConfig;
    const results = await Promise.allSettled([
      saveRuntimeEnvironment({ config: { kind: "native", env: { MODE: "first" }, secretEnv: ["TOKEN"] }, expected, secrets: { TOKEN: "first-secret" }, expectedSecretRevision: snapshot.secretRevision }),
      saveRuntimeEnvironment({ config: { kind: "native", env: { MODE: "second" }, secretEnv: ["TOKEN"] }, expected, secrets: { TOKEN: "second-secret" }, expectedSecretRevision: snapshot.secretRevision }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const mode = (await inspectRuntimeEnvironment()).userConfig.env!.MODE;
    expect(["first", "second"]).toContain(mode);
    const literalPairs: Record<string, string> = { first: "first-secret", second: "second-secret" };
    expect(await loadRuntimeSecrets("global", ["TOKEN"])).toEqual({ TOKEN: literalPairs[mode!] });
  });

  it("inherits a global secret reference without copying its value into project config or secret scope", async () => {
    await saveRuntimeSecrets("global", { TOKEN: "global-secret" });
    const initial = await inspectRuntimeEnvironment();
    await saveRuntimeEnvironment({ config: { kind: "native", secretEnv: ["TOKEN"], env: { MODE: "user" } }, expected: initial.userConfig });
    await saveRuntimeEnvironment({ cwd: project, config: { kind: "native", secretEnv: ["TOKEN"], env: { MODE: "project" } }, expected: null });
    expect(await loadRuntimeSecrets(project, ["TOKEN"])).toEqual({});
    expect(await loadRuntimeSecrets("global", ["TOKEN"])).toEqual({ TOKEN: "global-secret" });
    const snapshot = await inspectRuntimeEnvironment({ cwd: project });
    expect(snapshot.effective.secretEnv).toEqual(["TOKEN"]);
    expect(JSON.stringify(snapshot)).not.toContain("global-secret");
    expect(await readFile(join(project, ".vykor", "settings.json"), "utf8")).not.toContain("global-secret");
  });

  it("lets a project's ordinary variable replace an inherited secret reference without deleting the global secret", async () => {
    await saveRuntimeSecrets("global", { SHARED: "global-secret" });
    await updateSettings((current) => ({ ...current, agentEnvironment: { kind: "native", secretEnv: ["SHARED"] } }), { includeEnvironment: false });
    await saveProjectSettings({ agentEnvironment: { kind: "native", env: { SHARED: "project-ordinary" } } }, project);
    const effective = (await inspectRuntimeEnvironment({ cwd: project })).effective;
    expect(effective.env).toMatchObject({ SHARED: "project-ordinary" });
    expect(effective.secretEnv ?? []).not.toContain("SHARED");
    const core = (await loadSettings(undefined, { includeProject: true, projectRoot: project, includeEnvironment: false })).agentEnvironment!;
    expect(core.env).toMatchObject({ SHARED: "project-ordinary" });
    expect(core.secretEnv ?? []).not.toContain("SHARED");
    expect(await loadRuntimeSecrets("global", ["SHARED"])).toEqual({ SHARED: "global-secret" });
  });

  it("lets a project's secret reference replace an inherited ordinary variable without putting its value in snapshots", async () => {
    await updateSettings((current) => ({ ...current, agentEnvironment: { kind: "native", env: { SHARED: "user-ordinary" } } }), { includeEnvironment: false });
    await saveRuntimeSecrets(project, { SHARED: "project-secret" });
    await saveProjectSettings({ agentEnvironment: { kind: "native", secretEnv: ["SHARED"] } }, project);
    const snapshot = await inspectRuntimeEnvironment({ cwd: project });
    expect(snapshot.effective.env ?? {}).not.toHaveProperty("SHARED");
    expect(snapshot.effective.secretEnv).toEqual(["SHARED"]);
    expect(JSON.stringify(snapshot)).not.toContain("project-secret");
    const core = (await loadSettings(undefined, { includeProject: true, projectRoot: project, includeEnvironment: false })).agentEnvironment!;
    expect(core.env ?? {}).not.toHaveProperty("SHARED");
    expect(core.secretEnv).toEqual(["SHARED"]);
    expect((await inspectRuntimeEnvironment()).userConfig.env).toMatchObject({ SHARED: "user-ordinary" });
  });

  it("rejects the second editor changing only a secret value while its ordinary configuration is unchanged", async () => {
    const config: AgentEnvironmentSettings = { kind: "native", secretEnv: ["TOKEN"] };
    await saveRuntimeSecrets(project, { TOKEN: "initial-secret" });
    await saveProjectSettings({ agentEnvironment: config }, project);
    const editorOne = await inspectRuntimeEnvironment({ cwd: project });
    const editorTwo = await inspectRuntimeEnvironment({ cwd: project });
    await saveRuntimeEnvironment({ cwd: project, config, expected: editorOne.projectConfig, secrets: { TOKEN: "first-secret" }, expectedSecretRevision: editorOne.secretRevision });
    const confirmed = await readFile(join(project, ".vykor", "settings.json"), "utf8");
    await expect(saveRuntimeEnvironment({ cwd: project, config, expected: editorTwo.projectConfig, secrets: { TOKEN: "second-secret" }, expectedSecretRevision: editorTwo.secretRevision })).rejects.toBeInstanceOf(SettingsConflictError);
    expect(await loadRuntimeSecrets(project, ["TOKEN"])).toEqual({ TOKEN: "first-secret" });
    expect(await readFile(join(project, ".vykor", "settings.json"), "utf8")).toBe(confirmed);
  });

  it("rejects an editor secret update without the read secret revision before changing either file", async () => {
    const config: AgentEnvironmentSettings = { kind: "native", secretEnv: ["TOKEN"] };
    await saveRuntimeSecrets(project, { TOKEN: "initial-secret" });
    await saveProjectSettings({ agentEnvironment: config }, project);
    const before = await readFile(join(project, ".vykor", "settings.json"), "utf8");
    await expect(saveRuntimeEnvironment({ cwd: project, config, expected: config, secrets: { TOKEN: "replacement" } })).rejects.toThrow();
    expect(await loadRuntimeSecrets(project, ["TOKEN"])).toEqual({ TOKEN: "initial-secret" });
    expect(await readFile(join(project, ".vykor", "settings.json"), "utf8")).toBe(before);
  });

  it("rejects absent secret values and suspected plaintext secrets without changing user configuration", async () => {
    const before = await inspectRuntimeEnvironment();
    await expect(saveRuntimeEnvironment({ config: { kind: "native", secretEnv: ["MISSING_TOKEN"] }, expected: before.userConfig })).rejects.toThrow("尚未配置");
    await expect(saveRuntimeEnvironment({ config: { kind: "native", env: { API_KEY: "fixture-plain-secret" } }, expected: before.userConfig })).rejects.toThrow("标记为机密");
    expect((await loadSettings(undefined, { includeEnvironment: false })).agentEnvironment).toEqual(before.userConfig);
  });

  it("accepts a semantically identical expected config despite different object-key order", async () => {
    const original: AgentEnvironmentSettings = { kind: "native", env: { ONE: "one", TWO: "two" }, secretEnv: ["TOKEN"] };
    await saveRuntimeSecrets(project, { TOKEN: "secret" });
    await saveProjectSettings({ agentEnvironment: original }, project);
    const reordered: AgentEnvironmentSettings = { secretEnv: ["TOKEN"], env: { TWO: "two", ONE: "one" }, kind: "native" };
    await saveRuntimeEnvironment({ cwd: project, config: { ...original, env: { ONE: "next", TWO: "two" } }, expected: reordered });
    expect((await loadProjectSettings(project))?.agentEnvironment?.env?.ONE).toBe("next");
  });

  it("does not request restart when saved and active configurations differ only in key order", async () => {
    await updateSettings((current) => ({ ...current, agentEnvironment: { kind: "native", env: { ONE: "one", TWO: "two" }, secretEnv: ["TOKEN"] } }), { includeEnvironment: false });
    const active: AgentEnvironmentSettings = { secretEnv: ["TOKEN"], env: { TWO: "two", ONE: "one" }, kind: "native" };
    expect((await inspectRuntimeEnvironment({ activeDefault: active })).restartRequired).toBe(false);
  });

  it("treats omitted and empty environment maps and secret reference lists as the same active defaults", async () => {
    const snapshot = await inspectRuntimeEnvironment({ activeDefault: { kind: "native", env: {}, secretEnv: [] } });
    expect(snapshot.userConfig.kind).toBe("native");
    expect(snapshot.restartRequired).toBe(false);
  });

  it("does not request restart if kind is the only difference already fixed by the startup kind override", async () => {
    await updateSettings((current) => ({ ...current, agentEnvironment: { kind: "native" } }), { includeEnvironment: false });
    const snapshot = await inspectRuntimeEnvironment({ activeDefault: { kind: "wsl" }, kindOverride: "wsl" });
    expect(snapshot).toMatchObject({ userConfig: { kind: "native" }, effective: { kind: "wsl" }, source: "启动环境变量覆盖", restartRequired: false });
  });
});

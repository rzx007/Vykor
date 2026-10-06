import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadMcpServerConfigSnapshot, loadSettings, resolveOutputTokenCap, saveMcpServerConfig, saveProjectSettings, saveSettings, withMcpServerOAuthScopes } from "./settings.js";

describe("daemon settings", () => {
  const forbidden = JSON.parse(readFileSync(new URL("../../../../scripts/forbidden-compatibility-surfaces.json", import.meta.url), "utf8"));
  let configDir: string;
  let previousConfigDir: string | undefined;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "vykor-settings-"));
    previousConfigDir = process.env.VYKOR_CONFIG_DIR;
    process.env.VYKOR_CONFIG_DIR = configDir;
  });

  afterEach(() => {
    if (previousConfigDir === undefined) delete process.env.VYKOR_CONFIG_DIR;
    else process.env.VYKOR_CONFIG_DIR = previousConfigDir;
    rmSync(configDir, { recursive: true, force: true });
  });

  it.each(forbidden.configFields as string[])("rejects the removed config field %s before returning startup settings", async (field) => {
    writeFileSync(join(configDir, "settings.json"), JSON.stringify({ [field]: "old" }));
    await expect(loadSettings()).rejects.toMatchObject({
      name: "SettingsFileError", field: `settings.${field}`,
    });
  });

  it("keeps automatic daemon startup off by default", async () => {
    expect((await loadSettings()).daemon).toEqual({ autoStart: false });
    expect((await loadSettings()).plugins).toEqual({ enabled: true, uiEnabled: true });
    expect((await loadSettings()).workStyle).toBe("practical");
  });

  it.each(["user", "project"] as const)("never writes transient apiKey to %s settings", async (scope) => {
    const projectRoot = join(configDir, "key-project");
    const settings = { ...(await loadSettings()), apiKey: "fixture-transient", outputStyle: "fixture-style" };
    if (scope === "user") await saveSettings(settings);
    else await saveProjectSettings(settings, projectRoot);
    const saved = JSON.parse(readFileSync(scope === "user" ? join(configDir, "settings.json") : join(projectRoot, ".vykor", "settings.json"), "utf8"));
    expect(saved.apiKey).toBeUndefined();
    expect(saved.outputStyle).toBe("fixture-style");
    expect(settings.apiKey).toBe("fixture-transient");
  });

  it.each(["project", "global", "missing"] as const)("restores %s durable config when the synchronous MCP swap fails", async scope => {
    const projectRoot = join(configDir, "rollback-project");
    const projectConfigDir = join(projectRoot, ".vykor");
    mkdirSync(projectConfigDir, { recursive: true });
    const path = scope === "project" ? join(projectConfigDir, "settings.json") : join(configDir, "settings.json");
    const before = { effort: "high", mcpServers: { remote: { type: "http" as const, url: "https://mcp.example", headers: { Authorization: "Bearer old" } }, other: { type: "stdio" as const, command: "node" } } };
    if (scope !== "missing") writeFileSync(path, JSON.stringify(before));
    await expect(saveMcpServerConfig("remote", { type: "http", url: "https://mcp.example", headers: { Authorization: "Bearer new" } }, {
      projectRoot, commit: () => { throw new Error("registry changed during save"); },
    })).rejects.toThrow("registry changed during save");
    if (scope === "missing") expect(readdirSync(configDir)).not.toContain("settings.json");
    else expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(before);
  });

  it.each(["project", "global"] as const)("allows unrelated %s settings updates and equivalent target key order", async scope => {
    const projectRoot = join(configDir, "snapshot-project");
    mkdirSync(join(projectRoot, ".vykor"), { recursive: true });
    const path = scope === "project" ? join(projectRoot, ".vykor", "settings.json") : join(configDir, "settings.json");
    writeFileSync(path, JSON.stringify({ mcpServers: { remote: { type: "http", url: "https://mcp.example", headers: { "X-A": "1", "X-B": "2" } } } }));
    const snapshot = await loadMcpServerConfigSnapshot("remote", { projectRoot });
    writeFileSync(path, JSON.stringify({ effort: "high", mcpServers: { other: { type: "stdio", command: "added" }, remote: { headers: { "X-B": "2", "X-A": "1" }, url: "https://mcp.example", type: "http" } } }));
    let commits = 0;
    await expect(saveMcpServerConfig("remote", { type: "http", url: "https://mcp.example", headers: { Authorization: "Bearer updated" } }, { projectRoot, expected: snapshot, commit: () => { commits++; } })).resolves.toBe(scope);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ effort: "high", mcpServers: { other: { command: "added" }, remote: { headers: { Authorization: "Bearer updated" } } } });
    expect(commits).toBe(1);
  });

  it.each(["target", "empty", "only-other"] as const)("rejects a new project %s list without changing the captured global source", async kind => {
    const projectRoot = join(configDir, "new-override-project");
    mkdirSync(join(projectRoot, ".vykor"), { recursive: true });
    const globalPath = join(configDir, "settings.json");
    const projectPath = join(projectRoot, ".vykor", "settings.json");
    const config = { type: "http" as const, url: "https://mcp.example" };
    writeFileSync(globalPath, JSON.stringify({ mcpServers: { remote: config } }));
    const snapshot = await loadMcpServerConfigSnapshot("remote", { projectRoot });
    writeFileSync(projectPath, JSON.stringify({ mcpServers: kind === "empty" ? {} : kind === "only-other" ? { other: config } : { remote: config } }));
    const beforeGlobal = readFileSync(globalPath, "utf8");
    const beforeProject = readFileSync(projectPath, "utf8");
    let commits = 0;
    await expect(saveMcpServerConfig("remote", { ...config, headers: { Authorization: "Bearer stale" } }, { projectRoot, expected: snapshot, commit: () => { commits++; } })).rejects.toMatchObject({ code: "settings_conflict", field: "mcpServers.remote" });
    expect(readFileSync(globalPath, "utf8")).toBe(beforeGlobal);
    expect(readFileSync(projectPath, "utf8")).toBe(beforeProject);
    expect(commits).toBe(0);
  });

  it.each([{}, { other: { type: "stdio" as const, command: "node" } }])("captures a declared project MCP list as the effective source even without the target: %j", async mcpServers => {
    const projectRoot = join(configDir, "declared-project-list");
    mkdirSync(join(projectRoot, ".vykor"), { recursive: true });
    writeFileSync(join(configDir, "settings.json"), JSON.stringify({ mcpServers: { remote: { type: "http", url: "https://global.example" } } }));
    writeFileSync(join(projectRoot, ".vykor", "settings.json"), JSON.stringify({ mcpServers }));
    expect((await loadSettings(undefined, { includeProject: true, projectRoot })).mcpServers?.remote).toBeUndefined();
    expect(await loadMcpServerConfigSnapshot("remote", { projectRoot })).toEqual({ scope: "project", config: undefined });
  });

  it("loads an explicit efficient work style", async () => {
    writeFileSync(join(configDir, "settings.json"), JSON.stringify({
      workStyle: "efficient",
    }));

    expect((await loadSettings()).workStyle).toBe("efficient");
  });

  it("accepts and preserves the showReasoning setting", async () => {
    writeFileSync(
      join(configDir, "settings.json"),
      JSON.stringify({ showReasoning: false }),
    );

    const settings = await loadSettings();

    expect(settings.showReasoning).toBe(false);
  });

  it("defaults outputTokenMax to 32k and accepts an explicit value", async () => {
    expect((await loadSettings()).outputTokenMax).toBe(32_000);
    writeFileSync(join(configDir, "settings.json"), JSON.stringify({ outputTokenMax: 16_000 }));
    expect((await loadSettings()).outputTokenMax).toBe(16_000);
  });

  it("reads VYKOR_OUTPUT_TOKEN_MAX from the environment", async () => {
    process.env.VYKOR_OUTPUT_TOKEN_MAX = "8000";
    try {
      expect((await loadSettings()).outputTokenMax).toBe(8_000);
    } finally {
      delete process.env.VYKOR_OUTPUT_TOKEN_MAX;
    }
  });

  it("rejects a settings file that still carries the removed maxTokens field", async () => {
    writeFileSync(join(configDir, "settings.json"), JSON.stringify({ maxTokens: 16_384 }));
    await expect(loadSettings()).rejects.toMatchObject({
      name: "SettingsFileError",
      field: "settings.maxTokens",
    });
  });

  it("derives the output token cap from the catalog size", () => {
    expect(resolveOutputTokenCap(undefined, 32_000)).toBe(32_000);
    expect(resolveOutputTokenCap(4_096, 32_000)).toBe(4_096);
    expect(resolveOutputTokenCap(32_000, 32_000)).toBe(32_000);
    expect(resolveOutputTokenCap(60_000, 32_000)).toBe(32_000);
    expect(resolveOutputTokenCap(384_000, 32_000)).toBe(192_000);
  });

  it("merges the plugin master switch with project and CLI precedence", async () => {
    const projectRoot = join(configDir, "plugin-project");
    const projectConfigDir = join(projectRoot, ".vykor");
    mkdirSync(projectConfigDir, { recursive: true });
    writeFileSync(join(configDir, "settings.json"), JSON.stringify({
      plugins: { enabled: true },
    }));
    writeFileSync(join(projectConfigDir, "settings.json"), JSON.stringify({
      plugins: { enabled: false },
    }));

    expect((await loadSettings(undefined, { includeProject: true, projectRoot })).plugins).toEqual({ enabled: false, uiEnabled: true });
    expect((await loadSettings(
      { plugins: { enabled: true } },
      { includeProject: true, projectRoot },
    )).plugins).toEqual({ enabled: true, uiEnabled: true });
  });

  it.each(["user", "project"] as const)("preserves a disabled plugin UI flag after %s settings save and reload", async (scope) => {
    const projectRoot = join(configDir, "ui-project");
    if (scope === "user") {
      const settings = await loadSettings();
      await saveSettings({ ...settings, plugins: { enabled: true, uiEnabled: false } });
    } else {
      await saveProjectSettings({ plugins: { enabled: true, uiEnabled: false } }, projectRoot);
    }

    expect((await loadSettings(undefined, { includeProject: true, projectRoot })).plugins)
      .toEqual({ enabled: true, uiEnabled: false });
  });

  it.each([
    { user: false, project: true, cli: false },
    { user: true, project: false, cli: true },
  ])("merges the plugin UI flag with user, project and CLI precedence: %j", async ({ user, project, cli }) => {
    const projectRoot = join(configDir, "ui-precedence");
    const projectConfigDir = join(projectRoot, ".vykor");
    mkdirSync(projectConfigDir, { recursive: true });
    writeFileSync(join(configDir, "settings.json"), JSON.stringify({
      plugins: { enabled: false, uiEnabled: user },
    }));
    writeFileSync(join(projectConfigDir, "settings.json"), JSON.stringify({
      plugins: { uiEnabled: project },
    }));

    expect((await loadSettings()).plugins).toEqual({ enabled: false, uiEnabled: user });
    expect((await loadSettings(undefined, { includeProject: true, projectRoot })).plugins)
      .toEqual({ enabled: false, uiEnabled: project });
    expect((await loadSettings(
      { plugins: { enabled: false, uiEnabled: cli } },
      { includeProject: true, projectRoot },
    )).plugins).toEqual({ enabled: false, uiEnabled: cli });
  });

  it.each(
    (["user", "project", "CLI"] as const).flatMap(scope =>
      ["false", 0, null].map(value => ({ scope, value }))),
  )("rejects a non-boolean plugin UI flag from $scope: $value", async ({ scope, value }) => {
    const projectRoot = join(configDir, "invalid-ui-project");
    const projectConfigDir = join(projectRoot, ".vykor");
    mkdirSync(projectConfigDir, { recursive: true });
    if (scope !== "CLI") {
      writeFileSync(join(scope === "user" ? configDir : projectConfigDir, "settings.json"),
        JSON.stringify({ plugins: { uiEnabled: value } }));
    }

    await expect(loadSettings(
      scope === "CLI" ? { plugins: { enabled: true, uiEnabled: value as unknown as boolean } } : undefined,
      { includeProject: true, projectRoot },
    )).rejects.toMatchObject({ name: "SettingsFileError", field: "settings.plugins.uiEnabled" });
  });

  it.each(["user", "project"] as const)("rejects unknown plugin fields in %s settings alongside a valid UI flag", async (scope) => {
    const projectRoot = join(configDir, "unknown-plugin-project");
    const projectConfigDir = join(projectRoot, ".vykor");
    mkdirSync(projectConfigDir, { recursive: true });
    writeFileSync(join(scope === "user" ? configDir : projectConfigDir, "settings.json"),
      JSON.stringify({ plugins: { enabled: true, uiEnabled: false, unknown: true } }));

    await expect(loadSettings(undefined, { includeProject: true, projectRoot }))
      .rejects.toMatchObject({ name: "SettingsFileError", field: "settings.plugins.unknown" });
  });

  it("merges daemon.autoStart from the user settings file", async () => {
    writeFileSync(join(configDir, "settings.json"), JSON.stringify({
      daemon: { autoStart: true },
    }));

    const settings = await loadSettings();

    expect(settings.daemon).toEqual({ autoStart: true });
    expect(settings.model).toBeTruthy();
  });

  it("does not let project settings change machine-wide automatic startup", async () => {
    const projectRoot = join(configDir, "project");
    const projectConfigDir = join(projectRoot, ".vykor");
    mkdirSync(projectConfigDir, { recursive: true });
    writeFileSync(join(configDir, "settings.json"), JSON.stringify({
      daemon: { autoStart: false },
    }));
    writeFileSync(join(projectConfigDir, "settings.json"), JSON.stringify({
      daemon: { autoStart: true },
    }));

    const settings = await loadSettings(undefined, { includeProject: true, projectRoot });

    expect(settings.daemon).toEqual({ autoStart: false });
  });

  it("loads the current schema without a version marker", async () => {
    writeFileSync(join(configDir, "settings.json"), JSON.stringify({
      sandbox: { enabled: false },
      agentEnvironment: { kind: "wsl" },
      terminal: { localShell: "powershell.exe" },
    }));

    expect(await loadSettings()).toMatchObject({
      sandbox: { enabled: false },
      agentEnvironment: { kind: "wsl" },
      terminal: { localShell: "powershell.exe" },
    });
  });

  it("rejects version markers and deprecated sandbox fields", async () => {
    writeFileSync(join(configDir, "settings.json"), JSON.stringify({
      _formatVersion: 1,
      sandbox: { enabled: false },
    }));
    await expect(loadSettings()).rejects.toMatchObject({
      code: "invalid_settings_field",
    });

    writeFileSync(join(configDir, "settings.json"), JSON.stringify({
      sandbox: { enabled: true, runtime: "docker" },
    }));
    await expect(loadSettings()).rejects.toMatchObject({
      code: "invalid_settings_field",
    });
  });

  it("saves settings without adding a version marker", async () => {
    await saveSettings(await loadSettings());

    const saved = JSON.parse(
      readFileSync(join(configDir, "settings.json"), "utf-8"),
    ) as Record<string, unknown>;
    expect(saved).not.toHaveProperty("_formatVersion");
    expect(readdirSync(configDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("atomically replaces project settings without leaving temporary files", async () => {
    const projectRoot = join(configDir, "atomic-project");
    const projectConfigDir = join(projectRoot, ".vykor");
    mkdirSync(projectConfigDir, { recursive: true });
    writeFileSync(
      join(projectConfigDir, "settings.json"),
      JSON.stringify({ workStyle: "practical" }),
    );

    await saveProjectSettings({ workStyle: "efficient" }, projectRoot);

    expect(
      JSON.parse(readFileSync(join(projectConfigDir, "settings.json"), "utf8")),
    ).toEqual({ workStyle: "efficient" });
    expect(readdirSync(projectConfigDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("keeps custom providers user-scoped when project settings are included", async () => {
    const projectRoot = join(configDir, "provider-project");
    const projectConfigDir = join(projectRoot, ".vykor");
    mkdirSync(projectConfigDir, { recursive: true });
    const globalProvider = {
      id: "global-provider",
      displayName: "Global",
      baseUrl: "https://global.example/v1",
      apiFormat: "openai",
      models: [{ id: "chat", displayName: "Chat" }],
    };
    writeFileSync(
      join(configDir, "settings.json"),
      JSON.stringify({ customProviders: [globalProvider] }),
    );
    writeFileSync(
      join(projectConfigDir, "settings.json"),
      JSON.stringify({ customProviders: [{ ...globalProvider, id: "project-provider" }] }),
    );

    const settings = await loadSettings(undefined, {
      includeProject: true,
      projectRoot,
    });

    expect(settings.customProviders).toEqual([globalProvider]);
  });

  it("keeps custom providers user-scoped when CLI overrides customProviders", async () => {
    const globalProvider = {
      id: "global-provider",
      displayName: "Global",
      baseUrl: "https://global.example/v1",
      apiFormat: "openai",
      models: [{ id: "chat", displayName: "Chat" }],
    };
    writeFileSync(
      join(configDir, "settings.json"),
      JSON.stringify({ customProviders: [globalProvider] }),
    );

    const settings = await loadSettings({
      customProviders: [{ ...globalProvider, id: "cli-provider" }],
    });

    expect(settings.customProviders).toEqual([globalProvider]);
  });

  it("loads the local terminal shell preference", async () => {
    const projectRoot = join(configDir, "terminal-project");
    const projectConfigDir = join(projectRoot, ".vykor");
    mkdirSync(projectConfigDir, { recursive: true });
    writeFileSync(join(configDir, "settings.json"), JSON.stringify({
      terminal: { localShell: "powershell.exe" },
    }));
    writeFileSync(join(projectConfigDir, "settings.json"), JSON.stringify({}));

    expect(
      (await loadSettings(undefined, { includeProject: true, projectRoot }))
        .terminal,
    ).toEqual({ localShell: "powershell.exe" });
  });

  it("rejects the removed channels field", async () => {
    writeFileSync(join(configDir, "settings.json"), JSON.stringify({
      channels: { feishu: { enabled: true, appId: "cli_x", allowFrom: {} } },
    }));
    await expect(loadSettings()).rejects.toMatchObject({
      name: "SettingsFileError",
      field: "settings.channels",
    });
  });

  it("rejects the removed channels field in project settings", async () => {
    const projectRoot = join(configDir, "channels-project");
    const projectConfigDir = join(projectRoot, ".vykor");
    mkdirSync(projectConfigDir, { recursive: true });
    writeFileSync(join(projectConfigDir, "settings.json"), JSON.stringify({
      channels: { feishu: { enabled: true, appId: "x", allowFrom: {} } },
    }));
    await expect(
      loadSettings(undefined, { includeProject: true, projectRoot }),
    ).rejects.toMatchObject({
      field: "settings.channels",
    });
  });

  it("accepts non-secret MCP OAuth settings and rejects token fields", async () => {
    writeFileSync(join(configDir, "settings.json"), JSON.stringify({
      mcpServers: {
        linear: {
          type: "http",
          url: "https://mcp.linear.app/mcp",
          oauth: {
            scopes: ["read"],
            callbackPort: 43119,
            resourceUrl: "https://mcp.linear.app/mcp",
            callbackUrl: "http://127.0.0.1:43119/oauth/callback",
          },
        },
      },
    }));
    await expect(loadSettings()).resolves.toMatchObject({
      mcpServers: { linear: { oauth: { scopes: ["read"], resourceUrl: "https://mcp.linear.app/mcp" } } },
    });

    writeFileSync(join(configDir, "settings.json"), JSON.stringify({
      mcpServers: {
        linear: { type: "http", url: "https://mcp.linear.app/mcp", oauth: { accessToken: "secret" } },
      },
    }));
    await expect(loadSettings()).rejects.toMatchObject({
      field: "settings.mcpServers.linear.oauth.accessToken",
    });

    writeFileSync(join(configDir, "settings.json"), JSON.stringify({
      mcpServers: {
        linear: { type: "http", url: "https://mcp.linear.app/mcp", oauth: { resourceUrl: 42 } },
      },
    }));
    await expect(loadSettings()).rejects.toMatchObject({
      field: "settings.mcpServers.linear.oauth.resourceUrl",
    });
  });

  it("patches only the target server's non-secret oauth scopes", () => {
    const settings = {
      model: "m",
      apiFormat: "openai" as const,
      maxTurns: 1,
      permission: { mode: "default" as const },
      mcpServers: {
        linear: { type: "http" as const, url: "https://mcp.linear.app/mcp", oauth: { clientId: "c" } },
        github: { type: "http" as const, url: "https://mcp.github.com/mcp", oauth: { scopes: ["repo"] } },
        local: { type: "stdio" as const, command: "node" },
      },
    };

    const next = withMcpServerOAuthScopes(settings, "linear", ["read", "write"]);

    expect(next.mcpServers?.linear).toEqual({
      type: "http",
      url: "https://mcp.linear.app/mcp",
      oauth: { clientId: "c", scopes: ["read", "write"] },
    });
    expect(next.mcpServers?.github).toBe(settings.mcpServers.github);
    expect(next.mcpServers?.local).toBe(settings.mcpServers.local);
    expect(settings.mcpServers?.linear.oauth).toEqual({ clientId: "c" });
  });

  it("leaves settings untouched for an unknown or stdio server", () => {
    const settings = {
      model: "m",
      apiFormat: "openai" as const,
      maxTurns: 1,
      permission: { mode: "default" as const },
      mcpServers: { local: { type: "stdio" as const, command: "node" } },
    };
    expect(withMcpServerOAuthScopes(settings, "missing", ["read"])).toBe(settings);
    expect(withMcpServerOAuthScopes(settings, "local", ["read"])).toBe(settings);
  });

  it("accepts an enabled flag on every MCP transport", async () => {
    writeFileSync(join(configDir, "settings.json"), JSON.stringify({
      mcpServers: {
        off: { type: "stdio", command: "node", enabled: false },
        on: { type: "http", url: "https://mcp.example/mcp", enabled: true },
        legacy: { type: "sse", url: "https://mcp.example/sse", enabled: false },
      },
    }));

    const settings = await loadSettings();

    expect(settings.mcpServers?.off).toMatchObject({ type: "stdio", enabled: false });
    expect(settings.mcpServers?.on).toMatchObject({ type: "http", enabled: true });
    expect(settings.mcpServers?.legacy).toMatchObject({ type: "sse", enabled: false });
  });

  it("rejects a non-boolean MCP enabled flag", async () => {
    writeFileSync(join(configDir, "settings.json"), JSON.stringify({
      mcpServers: { bad: { type: "stdio", command: "node", enabled: "no" } },
    }));

    await expect(loadSettings()).rejects.toMatchObject({
      name: "SettingsFileError",
      field: "settings.mcpServers.bad.enabled",
    });
  });

  it("keeps automatic review off by default and accepts risk_based", async () => {
    expect((await loadSettings()).autoReview).toEqual({ mode: "off" });

    writeFileSync(
      join(configDir, "settings.json"),
      JSON.stringify({ autoReview: { mode: "risk_based" } }),
    );
    expect((await loadSettings()).autoReview).toEqual({ mode: "risk_based" });
  });

  it("accepts an automatic review mode from CLI overrides", async () => {
    expect((await loadSettings({ autoReview: { mode: "risk_based" } })).autoReview).toEqual({
      mode: "risk_based",
    });
  });

  it("rejects an unknown automatic review mode", async () => {
    writeFileSync(
      join(configDir, "settings.json"),
      JSON.stringify({ autoReview: { mode: "always" } }),
    );

    await expect(loadSettings()).rejects.toMatchObject({
      name: "SettingsFileError",
      field: "settings.autoReview.mode",
    });
  });

  it("rejects unknown fields nested under automatic review", async () => {
    writeFileSync(
      join(configDir, "settings.json"),
      JSON.stringify({ autoReview: { mode: "off", threshold: 1 } }),
    );

    await expect(loadSettings()).rejects.toMatchObject({
      field: "settings.autoReview.threshold",
    });
  });
});

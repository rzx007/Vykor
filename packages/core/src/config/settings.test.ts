import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadSettings, saveProjectSettings, saveSettings, withMcpServerOAuthScopes } from "./settings.js";

describe("daemon settings", () => {
  const forbidden = JSON.parse(readFileSync(new URL("../../../../scripts/forbidden-compatibility-surfaces.json", import.meta.url), "utf8"));
  let configDir: string;
  let previousConfigDir: string | undefined;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "openharness-settings-"));
    previousConfigDir = process.env.OPENHARNESS_CONFIG_DIR;
    process.env.OPENHARNESS_CONFIG_DIR = configDir;
  });

  afterEach(() => {
    if (previousConfigDir === undefined) delete process.env.OPENHARNESS_CONFIG_DIR;
    else process.env.OPENHARNESS_CONFIG_DIR = previousConfigDir;
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
    expect((await loadSettings()).plugins).toEqual({ enabled: true });
    expect((await loadSettings()).workStyle).toBe("practical");
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

  it("merges the plugin master switch with project and CLI precedence", async () => {
    const projectRoot = join(configDir, "plugin-project");
    const projectConfigDir = join(projectRoot, ".openharness-ts");
    mkdirSync(projectConfigDir, { recursive: true });
    writeFileSync(join(configDir, "settings.json"), JSON.stringify({
      plugins: { enabled: true },
    }));
    writeFileSync(join(projectConfigDir, "settings.json"), JSON.stringify({
      plugins: { enabled: false },
    }));

    expect((await loadSettings(undefined, { includeProject: true, projectRoot })).plugins).toEqual({ enabled: false });
    expect((await loadSettings(
      { plugins: { enabled: true } },
      { includeProject: true, projectRoot },
    )).plugins).toEqual({ enabled: true });
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
    const projectConfigDir = join(projectRoot, ".openharness-ts");
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
    const projectConfigDir = join(projectRoot, ".openharness-ts");
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
    const projectConfigDir = join(projectRoot, ".openharness-ts");
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
    const projectConfigDir = join(projectRoot, ".openharness-ts");
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
    const projectConfigDir = join(projectRoot, ".openharness-ts");
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
        linear: { type: "http", url: "https://mcp.linear.app/mcp", oauth: { scopes: ["read"], callbackPort: 43119 } },
      },
    }));
    await expect(loadSettings()).resolves.toMatchObject({
      mcpServers: { linear: { oauth: { scopes: ["read"] } } },
    });

    writeFileSync(join(configDir, "settings.json"), JSON.stringify({
      mcpServers: {
        linear: { type: "http", url: "https://mcp.linear.app/mcp", oauth: { accessToken: "secret" } },
      },
    }));
    await expect(loadSettings()).rejects.toMatchObject({
      field: "settings.mcpServers.linear.oauth.accessToken",
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
});

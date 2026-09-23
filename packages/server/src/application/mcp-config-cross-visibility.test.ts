import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSettings, updateSettings, type Settings } from "@openharness/core";

import { McpConfigApplicationService } from "./mcp-config-application-service.js";

/**
 * Cross-visibility between the CLI (which uses `loadSettings`/`updateSettings`
 * directly) and the Desktop application service, over one real settings file.
 */
describe("MCP global config cross-visibility", () => {
  let configDir: string;
  let previousConfigDir: string | undefined;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "oh-mcp-cross-"));
    previousConfigDir = process.env.OPENHARNESS_CONFIG_DIR;
    process.env.OPENHARNESS_CONFIG_DIR = configDir;
  });

  afterEach(() => {
    if (previousConfigDir === undefined) delete process.env.OPENHARNESS_CONFIG_DIR;
    else process.env.OPENHARNESS_CONFIG_DIR = previousConfigDir;
    rmSync(configDir, { recursive: true, force: true });
  });

  const service = () => new McpConfigApplicationService();

  const setServers = (mcpServers: NonNullable<Settings["mcpServers"]>) =>
    updateSettings((settings) => ({ ...settings, mcpServers }));

  it("sees CLI-written servers from the desktop service and vice versa", async () => {
    await setServers({
      beui: { type: "stdio", command: "npx", args: ["beui"] },
    });

    const listed = await service().list();
    expect(listed.servers.map((server) => server.name)).toContain("beui");

    await service().add({
      name: "linear",
      config: { type: "http", url: "https://mcp.linear.app/mcp", oauth: { scopes: ["read"] } },
    });

    const cliView = await loadSettings();
    expect(cliView.mcpServers?.linear).toMatchObject({
      type: "http",
      url: "https://mcp.linear.app/mcp",
    });
  });

  it("lists public HTTP, OAuth HTTP, stdio and disabled servers with safe summaries", async () => {
    await setServers({
      beui: { type: "stdio", command: "npx", args: ["beui"] },
      public: { type: "http", url: "https://public.example/mcp?token=query-secret" },
      linear: { type: "http", url: "https://mcp.linear.app/mcp", oauth: { scopes: ["read"] } },
      off: { type: "stdio", command: "node", enabled: false },
    });

    const listed = (await service().list()).servers;
    const byName = Object.fromEntries(listed.map((server) => [server.name, server]));

    expect(byName.public?.authMode).toBe("none");
    expect(byName.public?.summary).toBe("https://public.example/mcp");
    expect(byName.linear?.authMode).toBe("oauth");
    expect(byName.beui?.transport).toBe("stdio");
    expect(byName.beui?.summary).toBe("npx");
    expect(byName.off?.enabled).toBe(false);
    expect(JSON.stringify(listed)).not.toContain("query-secret");
  });

  it("exports only the global mcpServers map, never OAuth tokens", async () => {
    await setServers({
      linear: { type: "http", url: "https://mcp.linear.app/mcp", oauth: { scopes: ["read"] } },
    });

    const exported = await service().exportConfig();

    expect(Object.keys(exported)).toEqual(["mcpServers"]);
    const text = JSON.stringify(exported);
    expect(text).not.toContain("accessToken");
    expect(text).not.toContain("refreshToken");
  });

  it("persists configuration when no daemon is running and reports no runtime failures", async () => {
    await setServers({ beui: { type: "stdio", command: "npx" } });

    const result = await service().setEnabled({ name: "beui", enabled: false });

    expect(result).toEqual({ persisted: true, credentialRemoved: false, runtimeFailures: [] });
    expect((await loadSettings()).mcpServers?.beui).toMatchObject({ enabled: false });
  });
});

import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadProjectSettings, loadSettings, saveProjectSettings, saveSettings, updateSettings, withSettingsFileLock, ToolRegistry, type McpServerConfig, type Settings, type ToolDefinition } from "@vykor/core";
import type { McpClientManager, PreparedMcpConnection } from "@vykor/mcp";

import { applyMcpAuthConfig, createMcpAuthHost, defaultMcpEnvKey } from "./mcp-auth.js";

function fakeStagedManager(options: {
  tools?: ToolDefinition[];
  prepareError?: Error;
  onPrepare?: () => Promise<void>;
} = {}) {
  const closePrevious = vi.fn(async () => undefined);
  const discardPrepared = vi.fn(async () => undefined);
  const manager = {
    prepareConnection: vi.fn(async (name: string, config: McpServerConfig): Promise<PreparedMcpConnection> => {
      if (options.prepareError) throw options.prepareError;
      await options.onPrepare?.();
      return {
        name,
        connection: {
          name,
          config,
          status: "connected",
          transport: config.type,
          authConfigured: true,
          tools: [],
          resources: [],
        },
        client: { close: vi.fn(async () => undefined) } as unknown as PreparedMcpConnection["client"],
        transport: {} as PreparedMcpConnection["transport"],
        tools: options.tools ?? [],
      };
    }),
    activatePreparedConnection: vi.fn(
      (prepared: PreparedMcpConnection, commitTools: (tools: ToolDefinition[]) => void) => {
        try {
          commitTools(prepared.tools);
        } catch (error) {
          return { committed: false as const, error, discardPrepared };
        }
        return { committed: true as const, closePrevious };
      },
    ),
  } as unknown as McpClientManager;
  return { manager, closePrevious, discardPrepared };
}

function tool(name: string, description = name): ToolDefinition {
  return { name, description, inputSchema: {}, execute: vi.fn() };
}

const baseSettings: Settings = {
  model: "test-model",
  apiFormat: "anthropic",
  maxTurns: 10,
  permission: { mode: "default" },
};

describe("applyMcpAuthConfig", () => {
  it("writes bearer auth as an Authorization header for HTTP MCP servers", () => {
    const config = applyMcpAuthConfig("remote", { type: "http", url: "https://mcp.example" }, {
      serverName: "remote",
      mode: "bearer",
      value: "tok",
    });

    expect(config.headers).toEqual({ Authorization: "Bearer tok" });
  });

  it("writes custom header auth for HTTP MCP servers", () => {
    const config = applyMcpAuthConfig("remote", { type: "sse", url: "https://mcp.example/sse" }, {
      serverName: "remote",
      mode: "header",
      key: "X-API-Key",
      value: "secret",
    });

    expect(config.headers).toEqual({ "X-API-Key": "secret" });
  });

  it("writes env auth for stdio MCP servers", () => {
    const config = applyMcpAuthConfig("local-db", { type: "stdio", command: "node", args: ["server.js"] }, {
      serverName: "local-db",
      mode: "env",
      value: "secret",
    });

    expect(config.env).toEqual({ LOCAL_DB_API_KEY: "secret" });
  });

  it("rejects auth modes that cannot affect the server transport", () => {
    expect(() => applyMcpAuthConfig("local", { type: "stdio", command: "node" }, {
      serverName: "local",
      mode: "bearer",
      value: "tok",
    })).toThrow("bearer only works for HTTP/SSE");

    expect(() => applyMcpAuthConfig("remote", { type: "http", url: "https://mcp.example" }, {
      serverName: "remote",
      mode: "env",
      value: "tok",
    })).toThrow("env only works for stdio");

    expect(() => applyMcpAuthConfig("remote", { type: "http", url: "https://mcp.example" }, {
      serverName: "remote",
      mode: "header",
      value: "tok",
    })).toThrow("header requires a header key");
  });

  it("uses a stable default env key", () => {
    expect(defaultMcpEnvKey("local-db")).toBe("LOCAL_DB_API_KEY");
  });
});

describe("createMcpAuthHost", () => {
  it.each([
    ["global", "delete"], ["global", "disable"], ["global", "url"],
    ["project", "delete"], ["project", "disable"], ["project", "url"],
    ["global", "project-empty"], ["global", "project-other"],
  ] as const)("rejects %s target %s during auth preparation without overwriting the latest connection", async (scope, change) => {
    const dir = mkdtempSync(join(tmpdir(), "vykor-mcp-auth-cas-"));
    const previousDir = process.env.VYKOR_CONFIG_DIR;
    process.env.VYKOR_CONFIG_DIR = dir;
    const projectRoot = join(dir, "project");
    mkdirSync(join(projectRoot, ".vykor"), { recursive: true });
    const globalPath = join(dir, "settings.json");
    const projectPath = join(projectRoot, ".vykor", "settings.json");
    const targetPath = scope === "global" ? globalPath : projectPath;
    const oldConfig: McpServerConfig = { type: "http", url: "https://old.example", headers: { Authorization: "Bearer old" } };
    const shadow: McpServerConfig = { type: "http", url: "https://global-shadow.example" };
    writeFileSync(globalPath, JSON.stringify({ effort: "high", mcpServers: { remote: scope === "global" ? oldConfig : shadow } }));
    writeFileSync(projectPath, JSON.stringify({ outputStyle: "project", ...(scope === "project" ? { mcpServers: { remote: oldConfig } } : {}) }));
    const settings: Settings = { ...baseSettings, mcpServers: { remote: oldConfig } };
    const registry = new ToolRegistry();
    registry.register(tool("mcp__remote__latest"), { kind: "mcp", id: "remote" });
    let latestConnection: McpServerConfig | undefined = oldConfig;
    let latestDisk = "";
    let latestGlobal = "";
    let latestProject = "";
    const mutate = (current: Partial<Settings>) => {
      const mcpServers = { ...current.mcpServers };
      if (change === "delete") delete mcpServers.remote;
      else mcpServers.remote = change === "disable" ? { ...oldConfig, enabled: false } : { ...oldConfig, url: "https://updated.example" };
      return { ...current, mcpServers };
    };
    const { manager } = fakeStagedManager({ tools: [tool("mcp__remote__stale")], onPrepare: async () => {
      if (change === "project-empty" || change === "project-other") {
        await withSettingsFileLock(async () => {
          await saveProjectSettings({ outputStyle: "project", mcpServers: change === "project-empty" ? {} : { other: { type: "stdio", command: "latest-other" } } }, projectRoot);
        }, { lockPath: `${projectPath}.lock` });
      } else if (scope === "global") await updateSettings(current => mutate(current) as Settings);
      else await withSettingsFileLock(async () => { await saveProjectSettings(mutate((await loadProjectSettings(projectRoot)) ?? {}), projectRoot); }, { lockPath: `${projectPath}.lock` });
      const current = await loadSettings(undefined, { includeProject: true, projectRoot });
      latestConnection = current.mcpServers?.remote;
      settings.mcpServers = latestConnection ? { remote: latestConnection } : {};
      latestDisk = readFileSync(targetPath, "utf8");
      latestGlobal = readFileSync(globalPath, "utf8");
      latestProject = readFileSync(projectPath, "utf8");
    } });
    try {
      const host = createMcpAuthHost({ settings, mcpManager: manager, toolRegistry: registry, cwd: projectRoot });
      await expect(host.configure({ serverName: "remote", mode: "bearer", value: "stale-token" })).rejects.toMatchObject({ code: "settings_conflict", field: "mcpServers.remote" });
      expect(readFileSync(targetPath, "utf8")).toBe(latestDisk);
      expect(readFileSync(globalPath, "utf8")).toBe(latestGlobal);
      expect(readFileSync(projectPath, "utf8")).toBe(latestProject);
      expect(settings.mcpServers?.remote).toEqual(latestConnection);
      expect(manager.activatePreparedConnection).not.toHaveBeenCalled();
      expect(registry.has("mcp__remote__latest")).toBe(true);
      expect(registry.has("mcp__remote__stale")).toBe(false);
      const prepared = await vi.mocked(manager.prepareConnection).mock.results[0]!.value;
      expect(prepared.client.close).toHaveBeenCalledTimes(1);
    } finally {
      if (previousDir === undefined) delete process.env.VYKOR_CONFIG_DIR;
      else process.env.VYKOR_CONFIG_DIR = previousDir;
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("preserves unrelated runtime MCP settings refreshed during preparation", async () => {
    const settings: Settings = { ...baseSettings, mcpServers: { remote: { type: "http", url: "https://mcp.example" } } };
    const { manager } = fakeStagedManager();
    const host = createMcpAuthHost({ settings, mcpManager: manager, toolRegistry: new ToolRegistry(), persistSettings: async () => {
      settings.mcpServers = { ...settings.mcpServers, other: { type: "stdio", command: "updated-command" } };
    } });
    await host.configure({ serverName: "remote", mode: "bearer", value: "new" });
    expect(settings.mcpServers?.other).toEqual({ type: "stdio", command: "updated-command" });
    expect(settings.mcpServers?.remote?.headers).toEqual({ Authorization: "Bearer new" });
  });
  it("rolls back durable settings when tools conflict during persistence", async () => {
    const settings: Settings = { ...baseSettings, mcpServers: { remote: { type: "http", url: "https://mcp.example", headers: { Authorization: "Bearer old" } } } };
    const before = structuredClone(settings);
    let durable = structuredClone(settings);
    let saves = 0;
    const { manager, discardPrepared } = fakeStagedManager({ tools: [tool("mcp__remote__query")] });
    const registry = new ToolRegistry();
    registry.register(tool("mcp__remote__old"), { kind: "mcp", id: "remote" });
    const conflict = tool("mcp__remote__query", "caller-owned");
    const host = createMcpAuthHost({ settings, mcpManager: manager, toolRegistry: registry, persistSettings: async next => {
      durable = structuredClone(next);
      if (++saves === 1) registry.register(conflict, { kind: "agent" });
    } });
    await expect(host.configure({ serverName: "remote", mode: "bearer", value: "new" })).rejects.toMatchObject({ code: "tool_already_registered" });
    expect(durable).toEqual(before);
    expect(settings).toEqual(before);
    expect(registry.get("mcp__remote__query")).toBe(conflict);
    expect(registry.has("mcp__remote__old")).toBe(true);
    expect(discardPrepared).toHaveBeenCalledTimes(1);
  });
  it.each(["project", "global"] as const)("patches only the %s MCP source without copying merged settings", async (scope) => {
    const dir = mkdtempSync(join(tmpdir(), "vykor-mcp-auth-"));
    const previousDir = process.env.VYKOR_CONFIG_DIR;
    process.env.VYKOR_CONFIG_DIR = dir;
    const projectRoot = join(dir, "project");
    mkdirSync(join(projectRoot, ".vykor"), { recursive: true });
    const globalPath = join(dir, "settings.json");
    const projectPath = join(projectRoot, ".vykor", "settings.json");
    const oldConfig: McpServerConfig = { type: "http", url: "https://mcp.example", headers: { Authorization: "Bearer old" } };
    const targetPath = scope === "project" ? projectPath : globalPath;
    writeFileSync(globalPath, JSON.stringify({ effort: "high", mcpServers: { other: { type: "stdio", command: "node" }, ...(scope === "global" ? { remote: oldConfig } : {}) } }));
    writeFileSync(projectPath, JSON.stringify({ outputStyle: "project-style", ...(scope === "project" ? { mcpServers: { remote: oldConfig } } : {}) }));
    const untouchedPath = scope === "project" ? globalPath : projectPath;
    const untouched = readFileSync(untouchedPath, "utf8");
    try {
      const settings = { ...baseSettings, apiKey: "fixture-transient", model: "runtime-only", mcpServers: { remote: oldConfig } };
      const { manager } = fakeStagedManager({ onPrepare: async () => {
        await withSettingsFileLock(async () => {
          const current = JSON.parse(readFileSync(targetPath, "utf8"));
          const next = { ...current, mcpServers: { ...current.mcpServers, added: { type: "stdio", command: "added-during-prepare" } } };
          if (scope === "project") await saveProjectSettings(next, projectRoot);
          else await saveSettings(next);
        }, { lockPath: `${targetPath}.lock` });
      } });
      const host = createMcpAuthHost({ settings, mcpManager: manager, toolRegistry: new ToolRegistry(), cwd: projectRoot });
      await host.configure({ serverName: "remote", mode: "bearer", value: "new" });
      const saved = JSON.parse(readFileSync(targetPath, "utf8"));
      expect(saved.mcpServers.remote.headers.Authorization).toBe("Bearer new");
      expect(saved.apiKey).toBeUndefined();
      expect(saved.model).toBeUndefined();
      expect(saved.mcpServers.added.command).toBe("added-during-prepare");
      expect(readFileSync(untouchedPath, "utf8")).toBe(untouched);
      expect(settings.model).toBe("runtime-only");
    } finally {
      if (previousDir === undefined) delete process.env.VYKOR_CONFIG_DIR;
      else process.env.VYKOR_CONFIG_DIR = previousDir;
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("persists config, prepares the new connection, and atomically registers its tools", async () => {
    const settings: Settings = {
      ...baseSettings,
      mcpServers: { remote: { type: "http", url: "https://mcp.example" } },
    };
    let persisted: Settings | undefined;
    const { manager, closePrevious } = fakeStagedManager({
      tools: [tool("mcp__remote__query", "query")],
    });
    const registry = new ToolRegistry();
    registry.register(tool("mcp__remote__old", "old"), { kind: "mcp", id: "remote" });
    const host = createMcpAuthHost({
      settings,
      mcpManager: manager,
      toolRegistry: registry,
      persistSettings: async (next) => { persisted = next; },
    });

    const result = await host.configure({
      serverName: "remote",
      mode: "bearer",
      value: "tok",
    });

    expect(result.message).toContain("Saved MCP auth for remote");
    expect(persisted?.mcpServers?.remote?.headers).toEqual({ Authorization: "Bearer tok" });
    expect(settings.mcpServers?.remote?.headers).toEqual({ Authorization: "Bearer tok" });
    expect(manager.prepareConnection).toHaveBeenCalledWith("remote", {
      type: "http",
      url: "https://mcp.example",
      headers: { Authorization: "Bearer tok" },
    });
    expect(registry.has("mcp__remote__query")).toBe(true);
    expect(registry.inspect("mcp__remote__query")).toEqual({
      name: "mcp__remote__query",
      source: { kind: "mcp", id: "remote" },
    });
    expect(registry.has("mcp__remote__old")).toBe(false);
    expect(closePrevious).toHaveBeenCalledTimes(1);
  });

  it("reports reconnect failure instead of claiming success and keeps old tools", async () => {
    const settings: Settings = {
      ...baseSettings,
      mcpServers: { remote: { type: "http", url: "https://mcp.example" } },
    };
    const { manager } = fakeStagedManager({ prepareError: new Error("401 Unauthorized") });
    const registry = new ToolRegistry();
    registry.register(tool("mcp__remote__old", "old"), { kind: "mcp", id: "remote" });
    const previous = structuredClone(settings);
    let saves = 0;
    const host = createMcpAuthHost({
      settings,
      mcpManager: manager,
      toolRegistry: registry,
      persistSettings: async () => { saves++; },
    });

    await expect(host.configure({
      serverName: "remote",
      mode: "bearer",
      value: "tok",
    })).rejects.toThrow("reconnect failed: 401 Unauthorized");
    expect(registry.has("mcp__remote__old")).toBe(true);
    expect(settings).toEqual(previous);
    expect(saves).toBe(0);
    expect(manager.activatePreparedConnection).not.toHaveBeenCalled();
  });

  it("does not remove or replace a caller tool that resembles an MCP tool", async () => {
    const settings: Settings = {
      ...baseSettings,
      mcpServers: { remote: { type: "http", url: "https://mcp.example" } },
    };
    const callerTool = tool("mcp__remote__query", "caller-owned");
    const { manager } = fakeStagedManager({
      tools: [tool("mcp__remote__query", "mcp")],
    });
    const registry = new ToolRegistry();
    registry.register(callerTool, { kind: "agent" });
    let saves = 0;
    const previous = structuredClone(settings);
    const host = createMcpAuthHost({
      settings,
      mcpManager: manager,
      toolRegistry: registry,
      persistSettings: async () => { saves++; },
    });

    await expect(host.configure({
      serverName: "remote",
      mode: "bearer",
      value: "tok",
    })).rejects.toMatchObject({ code: "tool_already_registered" });
    expect(registry.get("mcp__remote__query")).toBe(callerTool);
    expect(registry.inspect("mcp__remote__query")?.source).toEqual({ kind: "agent" });
    expect(settings).toEqual(previous);
    expect(saves).toBe(0);
    const prepared = await vi.mocked(manager.prepareConnection).mock.results[0]!.value;
    expect(prepared.client.close).toHaveBeenCalledTimes(1);
  });

  it("leaves the registry unchanged when a later tool in the set conflicts", async () => {
    const settings: Settings = {
      ...baseSettings,
      mcpServers: { remote: { type: "http", url: "https://mcp.example" } },
    };
    const conflict = tool("mcp__remote__conflict", "caller-owned");
    const { manager } = fakeStagedManager({
      tools: [tool("mcp__remote__first", "first"), tool("mcp__remote__conflict", "mcp conflict")],
    });
    const registry = new ToolRegistry();
    registry.register(conflict, { kind: "agent" });
    const host = createMcpAuthHost({
      settings,
      mcpManager: manager,
      toolRegistry: registry,
      persistSettings: async () => {},
    });

    await expect(host.configure({
      serverName: "remote",
      mode: "bearer",
      value: "tok",
    })).rejects.toMatchObject({ code: "tool_already_registered" });
    expect(registry.has("mcp__remote__first")).toBe(false);
    expect(registry.get("mcp__remote__conflict")).toBe(conflict);
  });
});

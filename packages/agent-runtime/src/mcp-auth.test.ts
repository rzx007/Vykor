import { describe, expect, it, vi } from "vitest";
import { ToolRegistry, type McpServerConfig, type Settings, type ToolDefinition } from "@vykor/core";
import type { McpClientManager, PreparedMcpConnection } from "@vykor/mcp";

import { applyMcpAuthConfig, createMcpAuthHost, defaultMcpEnvKey } from "./mcp-auth.js";

function fakeStagedManager(options: {
  tools?: ToolDefinition[];
  prepareError?: Error;
} = {}) {
  const closePrevious = vi.fn(async () => undefined);
  const discardPrepared = vi.fn(async () => undefined);
  const manager = {
    prepareConnection: vi.fn(async (name: string, config: McpServerConfig): Promise<PreparedMcpConnection> => {
      if (options.prepareError) throw options.prepareError;
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
        client: {} as PreparedMcpConnection["client"],
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
    })).rejects.toThrow("reconnect failed: 401 Unauthorized");
    expect(registry.has("mcp__remote__old")).toBe(true);
  });

  it("does not remove or replace a caller tool that resembles an MCP tool", async () => {
    const settings: Settings = {
      ...baseSettings,
      mcpServers: { remote: { type: "http", url: "https://mcp.example" } },
    };
    const callerTool = tool("mcp__remote__query", "caller-owned");
    const { manager, discardPrepared } = fakeStagedManager({
      tools: [tool("mcp__remote__query", "mcp")],
    });
    const registry = new ToolRegistry();
    registry.register(callerTool, { kind: "agent" });
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
    expect(registry.get("mcp__remote__query")).toBe(callerTool);
    expect(registry.inspect("mcp__remote__query")?.source).toEqual({ kind: "agent" });
    expect(discardPrepared).toHaveBeenCalledTimes(1);
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

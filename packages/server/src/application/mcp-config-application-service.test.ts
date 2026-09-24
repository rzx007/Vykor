import { describe, expect, it, vi } from "vitest";
import type {
  McpOAuthCredentialRecord,
  McpRuntimeSyncResult,
  Settings,
} from "@vykor/core";
import type { McpOAuthCredentialStore } from "@vykor/mcp";
import { buildMcpAuthServerSnapshot } from "@vykor/mcp";
import {
  McpConfigApplicationService,
  type McpConfigApplicationServiceDeps,
} from "./mcp-config-application-service.js";

const unavailable: McpRuntimeSyncResult = {
  status: "unavailable",
  affectedRuntimes: 0,
  failures: [],
};

function credential(): McpOAuthCredentialRecord {
  return {
    serverUrl: "https://mcp.example/mcp",
    revision: 1,
    binding: {
      issuer: "https://auth.example",
      redirectUri: "http://127.0.0.1/callback",
      authorizationEndpoint: "https://auth.example/authorize",
      tokenEndpoint: "https://auth.example/token",
    },
    registration: { client_id: "client" },
    tokens: { accessToken: "secret", tokenType: "Bearer", scope: ["read"] },
  };
}

function linearConfig() {
  return {
    type: "http" as const,
    url: "https://mcp.example/mcp",
    oauth: { scopes: ["read"] },
  };
}

function createWorld() {
  const events: string[] = [];
  let settings: Settings = {
    model: "m",
    apiFormat: "anthropic",
    maxTurns: 1,
    permission: { mode: "default" },
    mcpServers: {
      linear: linearConfig(),
      local: { type: "stdio", command: "node", args: ["server.js"] },
    },
  };
  let hasCredential = true;
  let writeError: Error | undefined;
  let clearError: Error | undefined;

  const coordinator = {
    getStatus: vi.fn(async (): Promise<McpRuntimeSyncResult> => unavailable),
    synchronize: vi.fn(async (): Promise<McpRuntimeSyncResult> => unavailable),
    reconcileGlobal: vi.fn(async (): Promise<McpRuntimeSyncResult> => unavailable),
  };
  const credentialStore = {
    get: vi.fn(async (name: string) =>
      name === "linear" && hasCredential ? credential() : undefined,
    ),
    delete: vi.fn(async (name: string) => {
      events.push(`clear:${name}`);
      if (clearError) throw clearError;
      const had = name === "linear" && hasCredential;
      if (name === "linear") hasCredential = false;
      return had;
    }),
  } as unknown as McpOAuthCredentialStore;

  const snapshot = vi.fn(async () => ({
    servers: Object.entries(settings.mcpServers ?? {}).map(([name, config]) =>
      buildMcpAuthServerSnapshot({
        name,
        config,
        credential: name === "linear" && hasCredential ? credential() : undefined,
        runtimeStatus: "unavailable",
      }),
    ),
  }));

  function createService(overrides: Partial<McpConfigApplicationServiceDeps> = {}) {
    return new McpConfigApplicationService({
      loadSettings: async () => settings,
      updateSettings: async (change) => {
        events.push("write");
        if (writeError) throw writeError;
        settings = await change(settings);
        return settings;
      },
      snapshot,
      credentialStore,
      coordinator,
      ...overrides,
    });
  }

  return {
    createService,
    events,
    coordinator,
    credentialStore,
    getSettings: () => settings,
    setSettings: (next: Settings) => { settings = next; },
    hasCredential: () => hasCredential,
    setWriteError: (error: Error | undefined) => { writeError = error; },
    setClearError: (error: Error | undefined) => { clearError = error; },
  };
}

describe("McpConfigApplicationService", () => {
  it("adds a server without overwriting an existing name", async () => {
    const world = createWorld();
    const service = world.createService();

    const result = await service.add({
      name: "beui",
      config: { type: "stdio", command: "npx", args: ["beui"] },
    });

    expect(result).toEqual({ persisted: true, credentialRemoved: false, runtimeFailures: [] });
    expect(world.getSettings().mcpServers?.beui).toEqual({
      type: "stdio",
      command: "npx",
      args: ["beui"],
    });

    await expect(
      service.add({ name: "linear", config: { type: "stdio", command: "other" } }),
    ).rejects.toMatchObject({ code: "mcp-name-conflict" });
    expect(world.getSettings().mcpServers?.linear).toEqual(linearConfig());
  });

  it("rejects an invalid config before writing", async () => {
    const world = createWorld();
    const service = world.createService();

    await expect(
      service.add({ name: "bad", config: { type: "http" } as never }),
    ).rejects.toMatchObject({ code: "mcp-invalid-config", field: "settings.mcpServers.bad.url" });

    expect(world.getSettings().mcpServers?.bad).toBeUndefined();
    expect(world.events).not.toContain("write");
  });

  it("reports a conflict and keeps the config when the edit target changed", async () => {
    const world = createWorld();
    const service = world.createService();

    await expect(
      service.update({
        name: "linear",
        config: { type: "http", url: "https://mcp.example/v2" },
        expectedConfig: { type: "http", url: "https://mcp.example/stale" },
      }),
    ).rejects.toMatchObject({ code: "mcp-config-conflict" });

    expect(world.getSettings().mcpServers?.linear).toEqual(linearConfig());
  });

  it("updates a non-auth field without clearing credentials", async () => {
    const world = createWorld();
    const service = world.createService();

    const result = await service.update({
      name: "local",
      config: { type: "stdio", command: "node", args: ["server.js", "--flag"] },
      expectedConfig: { type: "stdio", command: "node", args: ["server.js"] },
    });

    expect(result).toEqual({ persisted: true, credentialRemoved: false, runtimeFailures: [] });
    expect(world.getSettings().mcpServers?.local).toMatchObject({
      args: ["server.js", "--flag"],
    });
  });

  it("clears an incompatible OAuth credential when the HTTP URL changes", async () => {
    const world = createWorld();
    const service = world.createService();

    const result = await service.update({
      name: "linear",
      config: { type: "http", url: "https://mcp.example/v2" },
      expectedConfig: linearConfig(),
    });

    expect(result.credentialRemoved).toBe(true);
    expect(world.hasCredential()).toBe(false);
    expect(world.getSettings().mcpServers?.linear).toMatchObject({ url: "https://mcp.example/v2" });
  });

  it("clears the credential when OAuth scopes change so the user re-authorizes", async () => {
    const world = createWorld();
    const service = world.createService();

    const result = await service.update({
      name: "linear",
      config: { type: "http", url: "https://mcp.example/mcp", oauth: { scopes: ["read", "write"] } },
      expectedConfig: linearConfig(),
    });

    expect(result.credentialRemoved).toBe(true);
    expect(world.hasCredential()).toBe(false);
    expect(world.getSettings().mcpServers?.linear).toMatchObject({
      oauth: { scopes: ["read", "write"] },
    });
  });

  it("still reconciles and reports the saved config when clearing the old credential fails", async () => {
    const world = createWorld();
    const service = world.createService();
    world.setClearError(new Error("locks busy"));

    await expect(
      service.update({
        name: "linear",
        config: { type: "http", url: "https://mcp.example/v2" },
        expectedConfig: linearConfig(),
      }),
    ).rejects.toMatchObject({ code: "mcp-credential-removal-failed" });

    expect(world.coordinator.reconcileGlobal).toHaveBeenCalledWith("linear");
    expect(world.getSettings().mcpServers?.linear).toMatchObject({ url: "https://mcp.example/v2" });
  });

  it("clears credentials before removing the config", async () => {
    const world = createWorld();
    const service = world.createService();

    const result = await service.remove("linear");

    expect(result).toEqual({ persisted: true, credentialRemoved: true, runtimeFailures: [] });
    expect(world.hasCredential()).toBe(false);
    expect(world.getSettings().mcpServers?.linear).toBeUndefined();
    expect(world.events.indexOf("clear:linear")).toBeLessThan(world.events.indexOf("write"));
  });

  it("keeps a concurrently replaced same-name server during removal", async () => {
    const world = createWorld();
    const replacement = { type: "http" as const, url: "https://replacement.example/mcp" };
    const credentialStore = {
      ...world.credentialStore,
      delete: async () => {
        world.setSettings({
          ...world.getSettings(),
          mcpServers: { ...world.getSettings().mcpServers, linear: replacement },
        });
        return true;
      },
    } as McpOAuthCredentialStore;
    const service = world.createService({ credentialStore });

    await expect(service.remove("linear")).rejects.toMatchObject({ code: "mcp-config-conflict" });
    expect(world.getSettings().mcpServers?.linear).toEqual(replacement);
  });

  it("reports a partial success when the credential is cleared but the config write fails", async () => {
    const world = createWorld();
    const service = world.createService();
    world.setWriteError(new Error("disk full"));

    const result = await service.remove("linear");

    expect(result).toEqual({ persisted: false, credentialRemoved: true, runtimeFailures: [] });
    expect(world.hasCredential()).toBe(false);
    expect(world.getSettings().mcpServers?.linear).toBeDefined();
  });

  it("keeps the config and reports an error when credential clearing fails", async () => {
    const world = createWorld();
    const service = world.createService();
    world.setClearError(new Error("locks busy"));

    await expect(service.remove("linear")).rejects.toMatchObject({
      code: "mcp-credential-removal-failed",
    });
    expect(world.getSettings().mcpServers?.linear).toBeDefined();
  });

  it("returns a persisted result with runtime failures when reconciliation fails", async () => {
    const world = createWorld();
    const service = world.createService();
    world.coordinator.reconcileGlobal.mockResolvedValueOnce({
      status: "error",
      affectedRuntimes: 1,
      failures: [{ runtimeId: "runtime-1", message: "reconnect failed" }],
    });

    const result = await service.add({
      name: "beui",
      config: { type: "stdio", command: "npx", args: ["beui"] },
    });

    expect(result.persisted).toBe(true);
    expect(result.runtimeFailures).toEqual([{ runtimeId: "runtime-1", message: "reconnect failed" }]);
  });

  it("treats an unreachable daemon as a reconcile failure, not a save failure", async () => {
    const world = createWorld();
    const service = world.createService();
    world.coordinator.reconcileGlobal.mockRejectedValueOnce(new Error("fetch failed"));

    const result = await service.setEnabled({ name: "linear", enabled: false });

    expect(result.persisted).toBe(true);
    expect(result.runtimeFailures).toHaveLength(1);
  });

  it("toggles the enabled flag and reconciles", async () => {
    const world = createWorld();
    const service = world.createService();

    const disabled = await service.setEnabled({ name: "linear", enabled: false });
    expect(disabled.persisted).toBe(true);
    expect(world.getSettings().mcpServers?.linear).toMatchObject({ enabled: false });
    expect(world.coordinator.reconcileGlobal).toHaveBeenCalledWith("linear");

    await service.setEnabled({ name: "linear", enabled: true });
    expect(world.getSettings().mcpServers?.linear?.enabled).toBeUndefined();
  });

  it("returns the full config only through getConfig and exports only mcpServers", async () => {
    const world = createWorld();
    const service = world.createService();

    await expect(service.getConfig("linear")).resolves.toEqual(linearConfig());
    await expect(service.getConfig("missing")).rejects.toMatchObject({ code: "mcp-not-found" });

    const exported = await service.exportConfig();
    expect(exported).toEqual({ mcpServers: world.getSettings().mcpServers });
    expect(exported).not.toHaveProperty("model");
  });

  it("list summaries strip query strings and show the stdio command", async () => {
    const world = createWorld();
    world.setSettings({
      ...world.getSettings(),
      mcpServers: {
        ...world.getSettings().mcpServers,
        tracked: { type: "http", url: "https://mcp.example/mcp?token=query-secret" },
      },
    });
    const service = world.createService();

    const list = await service.list();
    const tracked = list.servers.find((server) => server.name === "tracked");
    const local = list.servers.find((server) => server.name === "local");

    expect(tracked?.summary).toBe("https://mcp.example/mcp");
    expect(local?.summary).toBe("node");
    expect(JSON.stringify(list)).not.toContain("query-secret");
  });
});

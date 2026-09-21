import { describe, expect, it, vi } from "vitest";
import type { McpOAuthCredentialRecord, McpRuntimeSyncResult, Settings } from "@openharness/core";
import { McpOAuthError, type McpOAuthCredentialStore, type McpOAuthLoginResult } from "@openharness/mcp";
import { McpOAuthApplicationService, type McpOAuthApplicationServiceDeps } from "./mcp-oauth-application-service.js";

function credential(scopes: string[] = ["read"]): McpOAuthCredentialRecord {
  return {
    serverUrl: "https://mcp.example/mcp",
    revision: 1,
    binding: {
      issuer: "https://auth.example",
      redirectUri: "http://127.0.0.1/callback",
      authorizationEndpoint: "https://auth.example/authorize",
      tokenEndpoint: "https://auth.example/token",
    },
    registration: { client_id: "client", token_endpoint_auth_method: "none" },
    tokens: { accessToken: "secret", tokenType: "Bearer", scope: scopes },
  };
}

const unavailable: McpRuntimeSyncResult = { status: "unavailable", affectedRuntimes: 0, failures: [] };

function createWorld(options: { stored?: McpOAuthCredentialRecord | null } = {}) {
  let settings: Settings = {
    model: "m",
    apiFormat: "anthropic",
    maxTurns: 1,
    permission: { mode: "default" },
    mcpServers: {
      linear: { type: "http", url: "https://mcp.example/mcp", oauth: { scopes: ["read"] } },
      local: { type: "stdio", command: "node" },
      malformed: { type: "http", url: "not a URL" },
    },
  };
  let value = options.stored === null ? undefined : (options.stored ?? credential(["read"]));
  let lock: Promise<unknown> = Promise.resolve();
  let saveGate: Promise<void> | undefined;

  const store = {
    get: vi.fn(async (name: string) => (name === "linear" ? value : undefined)),
    set: vi.fn(async (name: string, next: McpOAuthCredentialRecord) => { if (name === "linear") value = next; }),
    delete: vi.fn(async (name: string) => {
      if (name !== "linear") return false;
      const had = value !== undefined;
      value = undefined;
      return had;
    }),
    update: vi.fn(async (name: string, mutate: (current: McpOAuthCredentialRecord | undefined) => McpOAuthCredentialRecord | undefined) =>
      name === "linear" ? (value = mutate(value)) : undefined),
    runExclusive: vi.fn(async (name: string, operation: (current: McpOAuthCredentialRecord | undefined) => Promise<{ next: McpOAuthCredentialRecord | undefined; result: unknown }>) => {
      const run = lock.then(async () => {
        const { next, result } = await operation(name === "linear" ? value : undefined);
        if (name === "linear") value = next;
        return result;
      });
      lock = run.then(() => undefined, () => undefined);
      return run;
    }),
  } as unknown as McpOAuthCredentialStore;

  const coordinator = {
    getStatus: vi.fn(async (): Promise<McpRuntimeSyncResult> => unavailable),
    synchronize: vi.fn(async (): Promise<McpRuntimeSyncResult> => unavailable),
  };
  const loginResults: McpOAuthLoginResult[] = [];
  const login = vi.fn(async () => loginResults.shift() ?? { status: "valid" as const, scopes: ["read"], verified: true, credential: credential() });
  const revoke = vi.fn(async () => { value = undefined; });
  const verify = vi.fn(async () => undefined);

  function createService(overrides: Partial<McpOAuthApplicationServiceDeps> = {}) {
    return new McpOAuthApplicationService({
      loadSettings: async () => settings,
      saveSettings: async (next) => { if (saveGate) await saveGate; settings = next; },
      store,
      coordinator,
      login,
      revoke,
      verify,
      ...overrides,
    });
  }

  return {
    createService,
    store,
    coordinator,
    login,
    revoke,
    loginResults,
    getValue: () => value,
    getSettings: () => settings,
    setSaveGate: (gate: Promise<void> | undefined) => { saveGate = gate; },
  };
}

describe("McpOAuthApplicationService", () => {
  it("returns stable, secret-free snapshots with auth mode and runtime status", async () => {
    const world = createWorld();
    const service = world.createService();

    await expect(service.snapshot()).resolves.toEqual({
      servers: [
        {
          name: "linear",
          enabled: true,
          transport: "http",
          endpoint: "https://mcp.example/mcp",
          authMode: "oauth",
          authStatus: "valid",
          scopes: ["read"],
          runtimeStatus: "unavailable",
        },
        {
          name: "local",
          enabled: true,
          transport: "stdio",
          authMode: "none",
          authStatus: "unsupported",
          scopes: [],
          runtimeStatus: "unavailable",
        },
        {
          name: "malformed",
          enabled: true,
          transport: "http",
          authMode: "none",
          authStatus: "not-logged-in",
          scopes: [],
          runtimeStatus: "unavailable",
        },
      ],
    });
    expect(JSON.stringify(await service.snapshot())).not.toContain("secret");
  });

  it("commits the verified credential and settings, then synchronizes runtimes", async () => {
    const world = createWorld({ stored: null });
    const service = world.createService();
    world.loginResults.push({ status: "valid", scopes: ["read", "write"], verified: true, credential: credential(["read", "write"]) });

    const snapshot = await service.login({ name: "linear", scopes: ["read", "write"], openBrowser: async () => undefined });

    expect(world.getValue()?.tokens.scope).toEqual(["read", "write"]);
    expect(world.getSettings().mcpServers?.linear).toMatchObject({ oauth: { scopes: ["read", "write"] } });
    expect(world.coordinator.synchronize).toHaveBeenCalledTimes(1);
    expect(snapshot.servers.find((server) => server.name === "linear")).toMatchObject({ authStatus: "valid" });
  });

  it("reports a verification failure without touching shared credentials or runtimes", async () => {
    const old = credential(["read"]);
    const world = createWorld({ stored: old });
    const service = world.createService();
    world.login.mockRejectedValueOnce(new McpOAuthError("oauth-login-verification-failed", "rejected"));

    await expect(service.login({ name: "linear", scopes: ["read"], openBrowser: async () => undefined }))
      .rejects.toMatchObject({ code: "oauth-login-verification-failed" });

    expect(world.getValue()).toEqual(old);
    expect(world.coordinator.synchronize).not.toHaveBeenCalled();
  });

  it("does not write a candidate credential when settings cannot be saved", async () => {
    const old = credential(["read"]);
    const world = createWorld({ stored: old });
    const service = world.createService({ saveSettings: async () => { throw new Error("disk full"); } });
    world.loginResults.push({ status: "valid", scopes: ["write"], verified: true, credential: credential(["write"]) });

    await expect(service.login({ name: "linear", scopes: ["write"], openBrowser: async () => undefined }))
      .rejects.toMatchObject({ code: "oauth-login-failed" });

    expect(world.getValue()).toEqual(old);
    expect(world.coordinator.synchronize).not.toHaveBeenCalled();
  });

  it("lets the last committer decide both settings scopes and the credential", async () => {
    const world = createWorld({ stored: null });
    const first = world.createService();
    const second = world.createService();
    let release!: () => void;
    world.setSaveGate(new Promise<void>((resolve) => { release = resolve; }));

    world.loginResults.push({ status: "valid", scopes: ["read"], verified: true, credential: credential(["read"]) });
    const loggingInFirst = first.login({ name: "linear", scopes: ["read"], openBrowser: async () => undefined });
    await vi.waitFor(() => expect(world.store.runExclusive).toHaveBeenCalledTimes(1));

    world.loginResults.push({ status: "valid", scopes: ["write"], verified: true, credential: credential(["write"]) });
    const loggingInSecond = second.login({ name: "linear", scopes: ["write"], openBrowser: async () => undefined });

    release();
    await Promise.all([loggingInFirst, loggingInSecond]);

    expect(world.getValue()?.tokens.scope).toEqual(["write"]);
    expect(world.getSettings().mcpServers?.linear).toMatchObject({ oauth: { scopes: ["write"] } });
  });

  it("reports a saved-but-not-reconnected failure without deleting the credential", async () => {
    const world = createWorld({ stored: null });
    const service = world.createService();
    world.loginResults.push({ status: "valid", scopes: ["read"], verified: true, credential: credential(["read"]) });
    world.coordinator.synchronize.mockResolvedValueOnce({
      status: "error",
      affectedRuntimes: 1,
      failures: [{ runtimeId: "runtime-1", message: "reconnect failed" }],
    });

    await expect(service.login({ name: "linear", scopes: ["read"], openBrowser: async () => undefined }))
      .rejects.toMatchObject({ code: "oauth-saved-runtime-sync-failed" });

    expect(world.getValue()?.tokens.scope).toEqual(["read"]);
  });

  it("classifies daemon rejection after login as saved-but-not-synchronized", async () => {
    const world = createWorld({ stored: null });
    const service = world.createService();
    world.coordinator.synchronize.mockRejectedValueOnce(new Error("daemon returned 401"));

    await expect(service.login({ name: "linear", scopes: ["read"], openBrowser: async () => undefined }))
      .rejects.toMatchObject({ code: "oauth-saved-runtime-sync-failed" });
    expect(world.getValue()?.tokens.scope).toEqual(["read"]);
  });

  it("backfills scopes, revokes, and disconnects runtimes on logout", async () => {
    const world = createWorld({ stored: credential(["read", "write"]) });
    const service = world.createService({ loadSettings: async () => {
      const current = world.getSettings();
      return { ...current, mcpServers: { ...current.mcpServers, linear: { type: "http", url: "https://mcp.example/mcp" } } };
    } });
    world.coordinator.synchronize.mockResolvedValueOnce({
      status: "error",
      affectedRuntimes: 1,
      failures: [{ runtimeId: "runtime-1", message: "disconnect failed" }],
    });

    await expect(service.logout("linear")).rejects.toMatchObject({ code: "oauth-removed-runtime-sync-failed" });

    expect(world.getValue()).toBeUndefined();
    expect(world.revoke).toHaveBeenCalledTimes(1);
  });

  it("does not put an untrusted settings error into a logout warning", async () => {
    const world = createWorld();
    const warn = vi.fn();
    const service = world.createService({
      loadSettings: async () => ({
        ...world.getSettings(),
        mcpServers: { linear: { type: "http", url: "https://mcp.example/mcp" } },
      }),
      saveSettings: async () => { throw new Error("Bearer access-secret https://mcp.example/mcp?token=query-secret"); },
      warn,
    });

    await service.logout("linear");

    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]![0]).not.toContain("access-secret");
    expect(warn.mock.calls[0]![0]).not.toContain("query-secret");
    expect(world.getValue()).toBeUndefined();
  });

  it("classifies daemon rejection after logout as removed-but-not-synchronized", async () => {
    const world = createWorld();
    const service = world.createService();
    world.coordinator.synchronize.mockRejectedValueOnce(new Error("protocol incompatible"));

    await expect(service.logout("linear"))
      .rejects.toMatchObject({ code: "oauth-removed-runtime-sync-failed" });
    expect(world.getValue()).toBeUndefined();
  });

  it("cancels and settles an active login before logout removes credentials", async () => {
    const world = createWorld({ stored: null });
    const service = world.createService();
    world.login.mockImplementation(async (input: { signal?: AbortSignal }) => {
      await new Promise<void>((_resolve, reject) => {
        input.signal?.addEventListener("abort", () => reject(input.signal?.reason), { once: true });
      });
      return { status: "valid", scopes: ["read"], verified: true, credential: credential() };
    });

    const loggingIn = service.login({ name: "linear", scopes: ["read"], openBrowser: vi.fn() });
    await vi.waitFor(() => expect(world.login).toHaveBeenCalled());
    const loggingOut = service.logout("linear");

    await expect(loggingIn).rejects.toThrow("cancelled by logout");
    await expect(loggingOut).resolves.toBeDefined();
    expect(world.revoke).toHaveBeenCalledTimes(1);
  });
});

import { describe, expect, it, vi } from "vitest";
import type { McpOAuthCredentialRecord, McpRuntimeSyncResult, Settings } from "@vykor/core";
import { McpOAuthError, type McpOAuthCredentialStore, type McpOAuthLoginResult } from "@vykor/mcp";
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
  let epoch = 0;
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
    takeAndDelete: vi.fn(async (name: string) => {
      if (name !== "linear") return undefined;
      const previous = value;
      value = undefined;
      epoch += 1;
      return previous;
    }),
    readLogoutEpoch: vi.fn(async (name: string) => (name === "linear" ? epoch : 0)),
    update: vi.fn(async (name: string, mutate: (current: McpOAuthCredentialRecord | undefined) => McpOAuthCredentialRecord | undefined) =>
      name === "linear" ? (value = mutate(value)) : undefined),
    runExclusive: vi.fn(async (name: string, operation: (current: McpOAuthCredentialRecord | undefined, context: { nextRevision: number; logoutEpoch: number }) => Promise<{ next: McpOAuthCredentialRecord | undefined; result: unknown }>) => {
      const run = lock.then(async () => {
        const current = name === "linear" ? value : undefined;
        const { next, result } = await operation(current, {
          nextRevision: (current?.revision ?? 0) + 1,
          logoutEpoch: name === "linear" ? epoch : 0,
        });
        if (name === "linear" && next !== current) value = next;
        return result;
      });
      lock = run.then(() => undefined, () => undefined);
      return run;
    }),
  } as unknown as McpOAuthCredentialStore;

  const coordinator = {
    getStatus: vi.fn(async (): Promise<McpRuntimeSyncResult> => unavailable),
    synchronize: vi.fn(async (): Promise<McpRuntimeSyncResult> => unavailable),
    reconcileGlobal: vi.fn(async (): Promise<McpRuntimeSyncResult> => unavailable),
  };
  const loginResults: McpOAuthLoginResult[] = [];
  const login = vi.fn(async () => loginResults.shift() ?? { status: "valid" as const, scopes: ["read"], verified: true, credential: credential() });
  const revoke = vi.fn(async () => { value = undefined; });
  const verify = vi.fn(async () => undefined);

  function createService(overrides: Partial<McpOAuthApplicationServiceDeps> = {}) {
    return new McpOAuthApplicationService({
      loadSettings: async () => settings,
      updateSettings: async (change) => { if (saveGate) await saveGate; settings = await change(settings); return settings; },
      credentialStore: store,
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
    setSettings: (next: Settings) => { settings = next; },
    setSaveGate: (gate: Promise<void> | undefined) => { saveGate = gate; },
    getEpoch: () => epoch,
    setEpoch: (next: number) => { epoch = next; },
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
          authStatus: "not-configured",
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

  it("preserves the public-server diagnosis instead of returning a generic login failure", async () => {
    const world = createWorld({ stored: null });
    const service = world.createService();
    world.login.mockRejectedValueOnce(new McpOAuthError("oauth-not-required", "OAuth is not required"));

    await expect(service.login({ name: "linear", scopes: [], openBrowser: async () => undefined }))
      .rejects.toMatchObject({
        code: "oauth-not-required",
        message: expect.stringContaining("does not require OAuth"),
      });
    expect(world.getValue()).toBeUndefined();
    expect(world.coordinator.synchronize).not.toHaveBeenCalled();
  });

  it("does not write a candidate credential when settings cannot be saved", async () => {
    const old = credential(["read"]);
    const world = createWorld({ stored: old });
    const service = world.createService({ updateSettings: async () => { throw new Error("disk full"); } });
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
      updateSettings: async () => { throw new Error("Bearer access-secret https://mcp.example/mcp?token=query-secret"); },
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
    await expect(loggingIn).rejects.toMatchObject({ name: "AbortError" });
    await expect(loggingOut).resolves.toBeDefined();
    expect(world.revoke).toHaveBeenCalledTimes(1);
  });

  it("rejects a commit whose logout epoch advanced while the browser was open", async () => {
    const world = createWorld({ stored: null });
    const service = world.createService();
    world.loginResults.push({ status: "valid", scopes: ["read"], verified: true, credential: credential(["read"]) });
    world.login.mockImplementationOnce(async () => {
      // A different store instance logged out for this service meanwhile.
      world.setEpoch(world.getEpoch() + 1);
      return { status: "valid" as const, scopes: ["read"], verified: true, credential: credential(["read"]) };
    });

    await expect(service.beginLogin({ name: "linear", scopes: ["read"], openBrowser: async () => undefined }))
      .rejects.toMatchObject({ code: "oauth-login-stale" });
    expect(world.getValue()).toBeUndefined();
    expect(world.coordinator.synchronize).not.toHaveBeenCalled();
  });

  it("rejects a commit whose authorization config changed while the browser was open", async () => {
    const world = createWorld({ stored: null });
    const service = world.createService();
    world.login.mockImplementationOnce(async () => {
      world.setSettings({
        ...world.getSettings(),
        mcpServers: {
          ...world.getSettings().mcpServers,
          linear: { type: "http", url: "https://moved.example/mcp", oauth: { scopes: ["read"] } },
        },
      });
      return { status: "valid" as const, scopes: ["read"], verified: true, credential: credential(["read"]) };
    });

    await expect(service.beginLogin({ name: "linear", scopes: ["read"], openBrowser: async () => undefined }))
      .rejects.toMatchObject({ code: "oauth-login-stale" });
    expect(world.getValue()).toBeUndefined();
  });

  it("cancels while waiting for the browser and never reaches commit", async () => {
    const world = createWorld({ stored: null });
    const service = world.createService();
    world.login.mockImplementation(async (input: { signal?: AbortSignal }) => {
      await new Promise<void>((_resolve, reject) => {
        input.signal?.addEventListener("abort", () => reject(input.signal?.reason), { once: true });
      });
      return { status: "valid" as const, scopes: ["read"], verified: true, credential: credential() };
    });
    const controller = new AbortController();
    const loggingIn = service.beginLogin({ name: "linear", scopes: ["read"], openBrowser: vi.fn(), signal: controller.signal });
    await vi.waitFor(() => expect(world.login).toHaveBeenCalled());
    controller.abort(new Error("user cancelled"));

    await expect(loggingIn).rejects.toThrow("user cancelled");
    expect(world.store.runExclusive).not.toHaveBeenCalled();
    expect(world.getValue()).toBeUndefined();
  });

  it("cancels while waiting for the credential lock so no candidate is written", async () => {
    const world = createWorld({ stored: null });
    const service = world.createService();
    world.loginResults.push({ status: "valid", scopes: ["read"], verified: true, credential: credential(["read"]) });

    let release!: () => void;
    const holding = world.store.runExclusive("linear", async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return { next: undefined, result: undefined };
    });

    const controller = new AbortController();
    const loggingIn = service.beginLogin({ name: "linear", scopes: ["read"], openBrowser: vi.fn(), signal: controller.signal });
    await vi.waitFor(() => expect(world.store.runExclusive).toHaveBeenCalledTimes(2));
    controller.abort(new Error("cancelled waiting for lock"));
    release();

    await expect(loggingIn).rejects.toThrow("cancelled waiting for lock");
    await holding;
    expect(world.getValue()).toBeUndefined();
  });

  it("keeps a committed credential when cancellation arrives after the commit point", async () => {
    const world = createWorld({ stored: null });
    const service = world.createService();
    world.loginResults.push({ status: "valid", scopes: ["read"], verified: true, credential: credential(["read"]) });

    let releaseSync!: () => void;
    world.coordinator.synchronize.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { releaseSync = resolve; });
      return unavailable;
    });

    const controller = new AbortController();
    const loggingIn = service.beginLogin({ name: "linear", scopes: ["read"], openBrowser: vi.fn(), signal: controller.signal });
    await vi.waitFor(() => expect(world.getValue()).toBeDefined());
    controller.abort(new Error("late cancel"));
    releaseSync();

    await expect(loggingIn).resolves.toMatchObject({ credentialCommitted: true });
    expect(world.getValue()?.tokens.scope).toEqual(["read"]);
  });

  it("does not save scopes or credentials when cancelled waiting for settings", async () => {
    const world = createWorld({ stored: null });
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const service = world.createService({ updateSettings: async (change) => {
      entered();
      await gate;
      const next = await change(world.getSettings());
      world.setSettings(next);
      return next;
    } });
    world.loginResults.push({ status: "valid", scopes: ["write"], verified: true, credential: credential(["write"]) });
    const controller = new AbortController();
    const loggingIn = service.beginLogin({ name: "linear", scopes: ["write"], openBrowser: vi.fn(), signal: controller.signal });
    const result = expect(loggingIn).rejects.toThrow("cancelled waiting for settings");
    await waiting;
    controller.abort(new Error("cancelled waiting for settings"));
    release();
    await result;
    expect(world.getValue()).toBeUndefined();
    expect(world.getSettings().mcpServers?.linear).toMatchObject({ oauth: { scopes: ["read"] } });
    expect(world.coordinator.synchronize).not.toHaveBeenCalled();
  });

  it("forwards manual callback validation feedback to the operation owner", async () => {
    const world = createWorld();
    const accepted = vi.fn();
    const rejected = vi.fn();
    const invalid = new McpOAuthError("oauth-state-mismatch", "Invalid state");
    const service = world.createService({ login: async (_input, deps) => {
      const callbacks = deps as typeof deps & {
        onCallbackAccepted?(): void;
        onCallbackRejected?(error: McpOAuthError): void;
      };
      callbacks?.onCallbackRejected?.(invalid);
      callbacks?.onCallbackAccepted?.();
      return { status: "valid", scopes: ["read"], verified: true, credential: credential() };
    } });
    await service.beginLogin({ name: "linear", scopes: ["read"], openBrowser: vi.fn(),
      ...{ onCallbackAccepted: accepted, onCallbackRejected: rejected } });
    expect(rejected).toHaveBeenCalledWith(invalid);
    expect(accepted).toHaveBeenCalledOnce();
  });
});

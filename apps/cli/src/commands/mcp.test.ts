import { describe, expect, it, vi } from "vitest";
import type { McpOAuthCredentialRecord, McpRuntimeStatus, Settings } from "@vykor/core";
import { buildMcpAuthServerSnapshot } from "@vykor/mcp";
import { McpOAuthApplicationError } from "@vykor/server";
import { VykorApiError } from "@vykor/client";
import { createMcpCommand, type McpCommandDeps } from "./mcp.js";

function credential(): McpOAuthCredentialRecord {
  return {
    serverUrl: "https://mcp.linear.app/mcp",
    revision: 1,
    binding: {
      issuer: "https://auth.linear.app",
      redirectUri: "http://127.0.0.1/callback",
      authorizationEndpoint: "https://auth.linear.app/authorize",
      tokenEndpoint: "https://auth.linear.app/token",
    },
    registration: { client_id: "client" },
    tokens: { accessToken: "secret", tokenType: "Bearer", scope: ["read"] },
  };
}

function fixture(options: { runtimeStatus?: McpRuntimeStatus } = {}) {
  let settings = {
    model: "test",
    apiFormat: "openai",
    maxTurns: 1,
    permission: { mode: "default" },
    mcpServers: {
      linear: { type: "http", url: "https://mcp.linear.app/mcp", oauth: { scopes: ["read"] } },
      local: { type: "stdio", command: "node", args: ["server.js"] },
      disabled: { type: "stdio", command: "node", args: ["off.js"], enabled: false },
      tracked: { type: "http", url: "https://mcp.example/mcp?token=query-secret" },
      malformed: { type: "http", url: "https://?token=malformed-secret" },
    },
  } as Settings;
  const credentials = new Map<string, McpOAuthCredentialRecord>();

  const snapshot = vi.fn(async () => ({
    servers: Object.entries(settings.mcpServers ?? {}).map(([name, config]) =>
      buildMcpAuthServerSnapshot({
        name,
        config,
        credential: credentials.get(name),
        runtimeStatus: options.runtimeStatus ?? "connected",
      }),
    ),
  }));
  const login = vi.fn(async (request: { name: string }) => {
    credentials.set(request.name, credential());
    return await snapshot();
  });
  const logout = vi.fn(async (name: string) => {
    credentials.delete(name);
    return await snapshot();
  });
  const output: string[] = [];
  const reconcile = vi.fn(async () => [] as Array<{ runtimeId: string; message: string }>);
  const deps: McpCommandDeps = {
    loadSettings: async () => settings,
    updateSettings: async change => { settings = change(settings); return settings; },
    application: { snapshot, login, logout },
    reconcile,
    openBrowser: vi.fn(async () => undefined),
    readLine: vi.fn(async () => "http://127.0.0.1/callback?code=ok&state=state"),
    stdout: line => output.push(line),
  };
  const run = (...args: string[]) => createMcpCommand(deps).parseAsync(["node", "vk", ...args]);
  return { deps, run, login, logout, output, credentials, snapshot, reconcile, getSettings: () => settings };
}

function daemonFixture() {
  const test = fixture();
  const operation = { loginId: "login-1", name: "linear", state: "pending" as const, credentialCommitted: false, authorizationReady: true, authorizationUrl: "https://auth.example/authorize" };
  const client = {
    protocol: { capabilities: vi.fn(async () => ({ features: { mcpOAuth: 1 }, mcpOAuth: { instanceId: "instance-1" } })) },
    mcp: {
      startLogin: vi.fn(async () => ({ loginId: "login-1", operation })),
      getLogin: vi.fn(async () => operation),
      watchLogin: vi.fn(async function* () { yield { event: "mcp.oauth.login.completed", data: { ...operation, state: "completed", credentialCommitted: true, authorizationReady: true, runtimeSync: { status: "connected", affectedRuntimes: 1, failures: [] } } }; }),
      submitCallback: vi.fn(async () => operation),
      cancelLogin: vi.fn(async () => operation),
      authStatus: vi.fn(async () => ({ servers: [{ name: "linear", scopes: ["read"], authStatus: "valid" }] })),
      logout: vi.fn(async () => ({ servers: [] })),
    },
  };
  test.deps.daemon = { connect: vi.fn(async () => ({ client: client as never, instanceId: "instance-1" })) };
  return { ...test, client, operation };
}

describe("mcp command", () => {
  it("uses the daemon operation and keeps the browser on this CLI host", async () => {
    const test = daemonFixture();
    await test.run("login", "linear");
    expect(test.client.mcp.startLogin).toHaveBeenCalledWith("linear", expect.objectContaining({ oauthInstanceId: "instance-1", callbackMode: "local" }), expect.any(Object));
    expect(test.deps.openBrowser).toHaveBeenCalledWith("https://auth.example/authorize");
    expect(test.login).not.toHaveBeenCalled();
  });

  it("recovers a lost accept response using the same request ID", async () => {
    const test = daemonFixture();
    test.client.mcp.startLogin.mockRejectedValueOnce(new TypeError("fetch failed"));
    await test.run("login", "linear");
    const requests = test.client.mcp.startLogin.mock.calls.map((call) => call[1] as { requestId: string });
    expect(requests).toHaveLength(2);
    expect(requests[0]?.requestId).toBe(requests[1]?.requestId);
    expect(test.login).not.toHaveBeenCalled();
  });

  it("resubscribes to the same login after a broken stream", async () => {
    const test = daemonFixture();
    test.client.mcp.watchLogin.mockImplementationOnce(async function* () { throw new TypeError("terminated"); });
    await test.run("login", "linear");
    expect(test.client.mcp.startLogin).toHaveBeenCalledTimes(1);
    expect(test.client.mcp.watchLogin).toHaveBeenCalledTimes(2);
    expect(test.client.mcp.getLogin).toHaveBeenCalledWith("login-1", expect.any(Object));
    expect(test.deps.openBrowser).toHaveBeenCalledTimes(1);
  });

  it("refuses recovery if the daemon instance changed", async () => {
    const test = daemonFixture();
    test.client.mcp.startLogin.mockRejectedValueOnce(new TypeError("fetch failed"));
    test.client.protocol.capabilities.mockResolvedValueOnce({ features: { mcpOAuth: 1 }, mcpOAuth: { instanceId: "instance-2" } });
    await expect(test.run("login", "linear")).rejects.toThrow("restarted");
    expect(test.client.mcp.startLogin).toHaveBeenCalledTimes(1);
    expect(test.login).not.toHaveBeenCalled();
  });

  it("does not fall back locally after a daemon authorization error", async () => {
    const test = daemonFixture();
    test.client.mcp.startLogin.mockRejectedValueOnce(new VykorApiError("unauthorized", 401, { error: "unauthorized" }));
    await expect(test.run("login", "linear")).rejects.toMatchObject({ status: 401 });
    expect(test.login).not.toHaveBeenCalled();
  });

  it("does not start local authorization when daemon discovery fails", async () => {
    const test = fixture();
    test.deps.daemon = { connect: vi.fn(async () => { throw new Error("MCP daemon registry could not be read"); }) };
    await expect(test.run("login", "linear")).rejects.toThrow("registry could not be read");
    expect(test.login).not.toHaveBeenCalled();
  });

  it("removes config after daemon logout removed credentials but Runtime sync failed", async () => {
    const test = daemonFixture();
    test.client.mcp.logout.mockRejectedValueOnce(new VykorApiError("sync failed", 500, { code: "oauth-removed-runtime-sync-failed", credentialRemoved: true }));
    await expect(test.run("remove", "linear")).rejects.toMatchObject({ status: 500 });
    expect(test.getSettings().mcpServers?.linear).toBeUndefined();
    expect(test.logout).not.toHaveBeenCalled();
    expect(test.output.join("\n")).toContain("credentials were removed");
  });

  it("prints the URL and submits the pasted callback in no-browser mode", async () => {
    const test = daemonFixture();
    await test.run("login", "linear", "--no-browser");
    expect(test.output.join("\n")).toContain("https://auth.example/authorize");
    expect(test.deps.readLine).toHaveBeenCalled();
    expect(test.client.mcp.submitCallback).toHaveBeenCalledWith("login-1", "http://127.0.0.1/callback?code=ok&state=state", expect.any(Object));
    expect(test.deps.openBrowser).not.toHaveBeenCalled();
  });

  it("stops waiting for pasted input when the daemon completes first", async () => {
    const test = daemonFixture();
    let inputAborted = false;
    test.deps.readLine = vi.fn(async (_prompt, signal) => await new Promise<string>((_resolve, reject) => {
      signal?.addEventListener("abort", () => { inputAborted = true; reject(new Error("input aborted")); }, { once: true });
    }));
    await test.run("login", "linear", "--no-browser");
    expect(inputAborted).toBe(true);
    expect(test.client.mcp.cancelLogin).not.toHaveBeenCalled();
  });

  it("closes the watch stream if manual input fails without cancelling the daemon operation", async () => {
    const test = daemonFixture();
    test.deps.readLine = vi.fn(async () => { throw new Error("input failed"); });
    test.client.mcp.watchLogin.mockImplementationOnce(async function* (_loginId: string, options: { signal?: AbortSignal }) {
      await new Promise<void>((resolve) => options.signal?.addEventListener("abort", () => resolve(), { once: true }));
    });
    await expect(test.run("login", "linear", "--no-browser")).rejects.toThrow("input failed");
    const signal = (test.client.mcp.watchLogin.mock.calls[0]?.[1] as { signal: AbortSignal }).signal;
    expect(signal.aborted).toBe(true);
    expect(test.client.mcp.cancelLogin).not.toHaveBeenCalled();
  });

  it("lets a rejected manual callback be pasted again without a new login", async () => {
    const test = daemonFixture();
    let complete!: () => void;
    const submitted = new Promise<void>((resolve) => { complete = resolve; });
    test.client.mcp.submitCallback.mockRejectedValueOnce(new VykorApiError("invalid callback", 400, { error: "invalid callback" }));
    test.client.mcp.submitCallback.mockImplementationOnce(async () => { complete(); return test.operation; });
    test.client.mcp.watchLogin.mockImplementationOnce(async function* () { await submitted; yield { event: "mcp.oauth.login.completed", data: { ...test.operation, state: "completed", credentialCommitted: true } }; });
    await test.run("login", "linear", "--no-browser");
    expect(test.client.mcp.startLogin).toHaveBeenCalledTimes(1);
    expect(test.client.mcp.submitCallback).toHaveBeenCalledTimes(2);
    expect(test.output.join("\n")).toContain("rejected");
  });

  it("exits nonzero when a committed login has a Runtime warning", async () => {
    const test = daemonFixture();
    test.client.mcp.watchLogin.mockImplementationOnce(async function* () { yield { event: "mcp.oauth.login.completed", data: { ...test.operation, state: "completed", credentialCommitted: true, runtimeSync: { status: "error", affectedRuntimes: 1, failures: [{ runtimeId: "r1", message: "failed" }] } } }; });
    await expect(test.run("login", "linear")).rejects.toThrow("Runtime");
    expect(test.output.join("\n")).toContain("saved");
  });
  it("adds HTTP and stdio servers using Codex-compatible shapes", async () => {
    const test = fixture();
    await test.run("add", "linear2", "--url", "https://mcp.linear.app/mcp");
    await test.run("add", "local2", "--", "node", "server.js");
    expect(test.getSettings().mcpServers).toMatchObject({
      linear2: { type: "http", url: "https://mcp.linear.app/mcp" },
      local2: { type: "stdio", command: "node", args: ["server.js"] },
    });
  });

  it("marks OAuth explicitly when add receives repeatable Codex-compatible scopes", async () => {
    const test = fixture();

    await test.run("add", "linear-oauth", "--url", "https://mcp.linear.app/mcp", "--scope", "read", "--scope", "issues:read");

    expect(test.getSettings().mcpServers?.["linear-oauth"]).toEqual({
      type: "http",
      url: "https://mcp.linear.app/mcp",
      oauth: { scopes: ["read", "issues:read"] },
    });
  });

  it("produces identical JSON for get and status with stable auth and runtime fields", async () => {
    const test = fixture({ runtimeStatus: "connected" });
    await test.run("get", "linear", "--json");
    const fromGet = test.output.at(-1)!;
    await test.run("status", "linear", "--json");
    const fromStatus = test.output.at(-1)!;

    expect(fromStatus).toEqual(fromGet);
    expect(JSON.parse(fromStatus)).toEqual({
      name: "linear",
      enabled: true,
      transport: "http",
      url: "https://mcp.linear.app/mcp",
      authMode: "oauth",
      authStatus: "not-logged-in",
      scopes: ["read"],
      runtimeStatus: "connected",
    });
    expect(fromStatus).not.toContain("secret");
  });

  it("shows auth mode, auth status and runtime state in human output", async () => {
    const test = fixture({ runtimeStatus: "disconnected" });
    await test.run("status", "linear");
    const text = test.output.join("\n");
    expect(text).toContain("auth-mode: oauth");
    expect(text).toContain("auth-status: not-logged-in");
    expect(text).toContain("runtime: disconnected");
    expect(text).toContain("endpoint: https://mcp.linear.app/mcp");
  });

  it("describes stdio servers without an endpoint URL", async () => {
    const test = fixture();
    await test.run("status", "local", "--json");
    expect(JSON.parse(test.output.at(-1)!)).toMatchObject({
      name: "local",
      transport: "stdio",
      command: "node",
      args: ["server.js"],
      authMode: "none",
      authStatus: "unsupported",
      runtimeStatus: "connected",
    });
  });

  it("reports the real enabled state instead of a fixed true", async () => {
    const test = fixture();

    await test.run("status", "disabled", "--json");
    expect(JSON.parse(test.output.at(-1)!)).toMatchObject({
      name: "disabled",
      enabled: false,
    });

    await test.run("status", "local", "--json");
    expect(JSON.parse(test.output.at(-1)!)).toMatchObject({
      name: "local",
      enabled: true,
    });
  });

  it("strips userinfo and query tokens from the CLI endpoint output", async () => {
    const test = fixture();

    await test.run("status", "tracked", "--json");

    const entry = JSON.parse(test.output.at(-1)!) as { url: string };
    expect(entry.url).toBe("https://mcp.example/mcp");
    expect(test.output.join("\n")).not.toContain("query-secret");
  });

  it("does not print a malformed endpoint that may contain a token", async () => {
    const test = fixture();

    await test.run("status", "malformed", "--json");

    expect(test.output.at(-1)).not.toContain("malformed-secret");
  });

  it("passes explicit scopes and no-browser to login", async () => {
    const test = fixture();
    await test.run("login", "linear", "--scopes", "read,issues:read", "--no-browser");
    expect(test.login).toHaveBeenCalledWith(expect.objectContaining({
      name: "linear",
      scopes: ["read", "issues:read"],
      noBrowser: true,
    }));
  });

  it("prints the authorization URL in offline no-browser mode", async () => {
    const test = fixture();
    test.login.mockImplementationOnce(async (request: { name: string; onAuthorizationUrl?: (url: string) => void }) => {
      request.onAuthorizationUrl?.("https://auth.example/authorize?state=private");
      return test.snapshot();
    });
    await test.run("login", "linear", "--no-browser");
    expect(test.output.join("\n")).toContain("https://auth.example/authorize?state=private");
    expect(test.deps.openBrowser).not.toHaveBeenCalled();
  });

  it("keeps login successful when no runtime is available", async () => {
    const test = fixture({ runtimeStatus: "unavailable" });
    await test.run("login", "linear");
    expect(test.output.join("\n")).toContain("Logged in to linear");
    expect(test.credentials.get("linear")).toBeDefined();
  });

  it("reports a saved-but-not-reconnected failure and keeps the credential", async () => {
    const test = fixture();
    test.login.mockImplementationOnce(async (request: { name: string }) => {
      test.credentials.set(request.name, credential());
      throw new McpOAuthApplicationError(
        "oauth-saved-runtime-sync-failed",
        "OAuth authorization was saved, but the active runtime failed to reconnect.",
        [{ runtimeId: "runtime-1", message: "reconnect failed" }],
      );
    });

    await expect(test.run("login", "linear")).rejects.toMatchObject({ code: "oauth-saved-runtime-sync-failed" });
    expect(test.output.join("\n")).toContain("authorization was saved for linear");
    expect(test.output.join("\n")).toContain("vk mcp status linear");
    expect(test.credentials.get("linear")).toBeDefined();
  });

  it("reports a removed-but-not-disconnected failure without restoring the credential", async () => {
    const test = fixture();
    test.credentials.set("linear", credential());
    test.logout.mockImplementationOnce(async () => {
      test.credentials.delete("linear");
      throw new McpOAuthApplicationError(
        "oauth-removed-runtime-sync-failed",
        "OAuth credentials were removed, but the active runtime failed to disconnect.",
        [{ runtimeId: "runtime-1", message: "disconnect failed" }],
      );
    });

    await expect(test.run("logout", "linear")).rejects.toMatchObject({ code: "oauth-removed-runtime-sync-failed" });
    expect(test.output.join("\n")).toContain("credentials were removed for linear");
    expect(test.credentials.get("linear")).toBeUndefined();
  });

  it("reconciles active sessions after add and reports sync failures", async () => {
    const test = fixture();
    test.reconcile.mockResolvedValueOnce([{ runtimeId: "runtime-1", message: "sync failed" }]);

    await test.run("add", "beui", "--", "npx", "beui");

    expect(test.reconcile).toHaveBeenCalledWith("beui");
    expect(test.output.join("\n")).toContain("failed to sync");
  });

  it("clears OAuth credentials before removing a configured server", async () => {
    const test = fixture();
    test.credentials.set("linear", credential());

    await test.run("remove", "linear");

    expect(test.logout).toHaveBeenCalledWith("linear");
    expect(test.credentials.get("linear")).toBeUndefined();
    expect(test.getSettings().mcpServers?.linear).toBeUndefined();
  });

  it("removes local config but reports runtime disconnection failure", async () => {
    const test = fixture();
    test.credentials.set("linear", credential());
    test.logout.mockImplementationOnce(async () => {
      test.credentials.delete("linear");
      throw new McpOAuthApplicationError(
        "oauth-removed-runtime-sync-failed",
        "OAuth credentials were removed, but a runtime failed to disconnect.",
        [{ runtimeId: "runtime-1", message: "MCP runtime synchronization failed" }],
      );
    });

    await expect(test.run("remove", "linear"))
      .rejects.toMatchObject({ code: "oauth-removed-runtime-sync-failed" });
    expect(test.credentials.get("linear")).toBeUndefined();
    expect(test.getSettings().mcpServers?.linear).toBeUndefined();
    expect(test.output.join("\n")).toContain("credentials were removed for linear");
  });
});

import { describe, expect, it, vi } from "vitest";
import type { McpOAuthCredentialRecord } from "@openharness/core";
import { McpOAuthApplicationService } from "./mcp-oauth-application-service.js";

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
    registration: { client_id: "client", token_endpoint_auth_method: "none" },
    tokens: { accessToken: "secret", tokenType: "Bearer", scope: ["read"] },
  };
}

function fixture(stored: McpOAuthCredentialRecord | null = credential()) {
  let value: McpOAuthCredentialRecord | undefined = stored ?? undefined;
  const store = {
    get: vi.fn(async (name) => (name === "linear" ? value : undefined)),
    set: vi.fn(async (name, next) => {
      if (name === "linear") value = next;
    }),
    delete: vi.fn(async (name) => {
      if (name !== "linear") return false;
      const existed = Boolean(value);
      value = undefined;
      return existed;
    }),
    update: vi.fn(async (name, mutate) =>
      name === "linear" ? (value = mutate(value)) : undefined,
    ),
    runExclusive: vi.fn(),
  };
  const runtime = {};
  const login = vi.fn(async () => ({
    status: "valid" as const,
    scopes: ["read"],
    verified: true,
  }));
  const revoke = vi.fn(async () => {
    value = undefined;
  });
  const verify = vi.fn(async () => undefined);
  const service = new McpOAuthApplicationService({
    loadSettings: async () => ({
      mcpServers: {
        linear: {
          type: "http",
          url: "https://mcp.example/mcp",
          oauth: { scopes: ["read"] },
        },
        local: { type: "stdio", command: "node" },
        malformed: { type: "http", url: "not a URL" },
      },
    }),
    store,
    runtime: runtime as never,
    login,
    revoke,
    verify,
  });
  return { service, login, revoke, verify };
}

describe("McpOAuthApplicationService", () => {
  it("returns stable, secret-free server status", async () => {
    const { service } = fixture();
    await expect(service.snapshot()).resolves.toEqual({
      servers: [
        {
          name: "linear",
          transport: "http",
          endpoint: "https://mcp.example/mcp",
          authStatus: "valid",
          scopes: ["read"],
        },
        {
          name: "local",
          transport: "stdio",
          authStatus: "unsupported",
          scopes: [],
        },
        {
          name: "malformed",
          transport: "http",
          authStatus: "not-logged-in",
          scopes: [],
        },
      ],
    });
    expect(JSON.stringify(await service.snapshot())).not.toContain("secret");
  });

  it("delegates interactive login and connection verification", async () => {
    const { service, login, verify } = fixture(null);
    const openBrowser = vi.fn(async () => undefined);
    await service.login({ name: "linear", scopes: ["read"], openBrowser });
    expect(login).toHaveBeenCalledWith(
      expect.objectContaining({
        serverName: "linear",
        scopes: ["read"],
        signal: expect.any(AbortSignal),
      }),
      expect.objectContaining({
        openBrowser: expect.any(Function),
        verifyConnection: expect.any(Function),
      }),
    );
    const loginDeps = login.mock.calls[0]?.[1];
    await loginDeps?.openBrowser?.("https://auth.example/authorize");
    expect(openBrowser).toHaveBeenCalledWith("https://auth.example/authorize");
    const verifyConnection = loginDeps?.verifyConnection;
    await verifyConnection?.({
      serverName: "linear",
      config: { type: "http", url: "https://mcp.example/mcp" },
    });
    expect(verify).toHaveBeenCalled();
  });

  it("revokes credentials before returning the updated snapshot", async () => {
    const { service, revoke } = fixture();
    const snapshot = await service.logout("linear");
    expect(
      snapshot.servers.find((server) => server.name === "linear"),
    ).toMatchObject({ authStatus: "not-logged-in" });
    expect(revoke).toHaveBeenCalledWith(
      expect.objectContaining({ serverName: "linear" }),
    );
  });

  it("uses configured scopes before the first login", async () => {
    const { service } = fixture(null);
    const snapshot = await service.snapshot();
    expect(
      snapshot.servers.find((server) => server.name === "linear"),
    ).toMatchObject({ authStatus: "not-logged-in", scopes: ["read"] });
  });

  it("cancels and settles an active login before logout removes credentials", async () => {
    const { service, login, revoke } = fixture(null);
    login.mockImplementation(async (input) => {
      await new Promise<void>((_resolve, reject) => {
        input.signal?.addEventListener(
          "abort",
          () => reject(input.signal?.reason),
          { once: true },
        );
      });
      return { status: "valid", scopes: ["read"], verified: true };
    });

    const loggingIn = service.login({
      name: "linear",
      scopes: ["read"],
      openBrowser: vi.fn(),
    });
    await vi.waitFor(() => expect(login).toHaveBeenCalled());
    const loggingOut = service.logout("linear");

    await expect(loggingIn).rejects.toThrow("cancelled by logout");
    await expect(loggingOut).resolves.toBeDefined();
    expect(revoke).toHaveBeenCalledTimes(1);
  });
});

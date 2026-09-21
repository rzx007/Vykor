import { describe, expect, it, vi } from "vitest";
import type { McpOAuthCredentialRecord } from "@openharness/core";
import type { OAuthCallbackController } from "./callback.js";
import { loginMcpOAuth, type McpOAuthCredentialStore } from "./login.js";

function memoryStore(initial?: McpOAuthCredentialRecord): McpOAuthCredentialStore & { value?: McpOAuthCredentialRecord } {
  const store = {
    value: initial,
    get: async () => store.value,
    set: async (_name: string, value: McpOAuthCredentialRecord) => { store.value = value; },
    delete: async () => { const found = !!store.value; store.value = undefined; return found; },
    update: async (_name: string, mutate: (current: McpOAuthCredentialRecord | undefined) => McpOAuthCredentialRecord | undefined) => (store.value = mutate(store.value)),
    runExclusive: async <T>(_name: string, operation: (current: McpOAuthCredentialRecord | undefined) => Promise<{ next: McpOAuthCredentialRecord | undefined; result: T }>) => {
      const result = await operation(store.value); store.value = result.next; return result.result;
    },
  };
  return store;
}

function callbackFactory(events: string[]) {
  return vi.fn(async (options: { expectedIssuer: string }) => {
    events.push("callback");
    return {
      redirectUri: "http://127.0.0.1:43119/oauth/callback",
      wait: async () => ({ code: "code", issuer: options.expectedIssuer }),
      accept: async () => ({ code: "code", issuer: options.expectedIssuer }),
      close: async () => undefined,
    } as OAuthCallbackController;
  });
}

function loginFetch(options: { revocationEndpoint?: boolean; revoked?: string[] } = {}) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://mcp.test/mcp") return new Response("", { status: 401, headers: { "www-authenticate": "Bearer resource_metadata=\"https://mcp.test/.well-known/oauth-protected-resource/mcp\"" } });
    if (url.includes("oauth-protected-resource")) return Response.json({ resource: "https://mcp.test/mcp", authorization_servers: ["https://auth.test"], scopes_supported: ["read", "write"] });
    if (url.includes("oauth-authorization-server")) return Response.json({
      issuer: "https://auth.test",
      authorization_endpoint: "https://auth.test/authorize",
      token_endpoint: "https://auth.test/token",
      registration_endpoint: "https://auth.test/register",
      ...(options.revocationEndpoint ? { revocation_endpoint: "https://auth.test/revoke" } : {}),
      response_types_supported: ["code"],
      code_challenge_methods_supported: ["S256"],
      authorization_response_iss_parameter_supported: true,
    });
    if (url === "https://auth.test/register") return Response.json({ client_id: "client", redirect_uris: ["http://127.0.0.1:43119/oauth/callback"], token_endpoint_auth_method: "none" });
    if (url === "https://auth.test/token") return Response.json({ access_token: "access", refresh_token: "refresh", token_type: "Bearer", scope: "read" });
    if (url === "https://auth.test/revoke") {
      options.revoked?.push(new URLSearchParams(String(init?.body)).get("token") ?? "");
      return new Response("", { status: 200 });
    }
    throw new Error(`Unexpected URL: ${url}`);
  }) as unknown as typeof globalThis.fetch;
}

describe("loginMcpOAuth", () => {
  it("returns the verified candidate without writing the shared store", async () => {
    const store = memoryStore();
    const events: string[] = [];
    const fetch = loginFetch();

    const result = await loginMcpOAuth({
      serverName: "linear",
      config: { type: "http", url: "https://mcp.test/mcp" },
      scopes: ["read"],
      store,
    }, { fetch, callbackFactory: callbackFactory(events) as any, openBrowser: async () => undefined, verifyConnection: async () => undefined });

    expect(result.status).toBe("valid");
    expect(result.verified).toBe(true);
    expect(result.scopes).toEqual(["read"]);
    expect(result.credential.tokens).toMatchObject({ accessToken: "access", scope: ["read"] });
    expect(store.value).toBeUndefined();
  });

  it("verifies through an operation-local store and returns the refreshed candidate", async () => {
    const store = memoryStore();
    const seen: McpOAuthCredentialStore[] = [];

    const result = await loginMcpOAuth({
      serverName: "linear",
      config: { type: "http", url: "https://mcp.test/mcp" },
      scopes: ["read"],
      store,
    }, {
      fetch: loginFetch(),
      callbackFactory: callbackFactory([]) as any,
      openBrowser: async () => undefined,
      verifyConnection: async ({ store: candidateStore }) => {
        seen.push(candidateStore);
        expect(await candidateStore.get("linear")).toMatchObject({ tokens: { accessToken: "access" } });
        await candidateStore.update("linear", (current) => ({
          ...current!,
          tokens: { ...current!.tokens, accessToken: "refreshed" },
        }));
      },
    });

    expect(seen).toHaveLength(1);
    expect(result.credential.tokens.accessToken).toBe("refreshed");
    expect(store.value).toBeUndefined();
  });

  it("verifies a changed explicit scope using the requested scopes rather than old settings", async () => {
    const store = memoryStore();
    let verifiedScopes: string[] | undefined;

    await loginMcpOAuth({
      serverName: "linear",
      config: { type: "http", url: "https://mcp.test/mcp", oauth: { scopes: ["write"] } },
      scopes: ["read"],
      store,
    }, {
      fetch: loginFetch(),
      callbackFactory: callbackFactory([]) as any,
      openBrowser: async () => undefined,
      verifyConnection: async ({ config }) => { verifiedScopes = config.oauth?.scopes; },
    });

    expect(verifiedScopes).toEqual(["read"]);
  });

  it("revokes the in-memory candidate and leaves the shared store untouched when verification fails", async () => {
    const existing = memoryStore(undefined);
    const revoked: string[] = [];

    await expect(loginMcpOAuth({
      serverName: "linear",
      config: { type: "http", url: "https://mcp.test/mcp" },
      scopes: ["read"],
      store: existing,
    }, {
      fetch: loginFetch({ revocationEndpoint: true, revoked }),
      callbackFactory: callbackFactory([]) as any,
      openBrowser: async () => undefined,
      verifyConnection: async () => { throw new Error("unauthorized"); },
    })).rejects.toMatchObject({ code: "oauth-login-verification-failed" });

    expect(existing.value).toBeUndefined();
    expect(revoked).toEqual(expect.arrayContaining(["refresh", "access"]));
  });
});

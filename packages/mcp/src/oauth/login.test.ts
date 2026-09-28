import { describe, expect, it, vi } from "vitest";
import type { McpOAuthCredentialRecord } from "@vykor/core";
import type { OAuthCallbackController } from "./callback.js";
import { loginMcpOAuth, revokeMcpOAuthCredential, type McpOAuthCredentialStore } from "./login.js";
import { McpOAuthRuntime } from "./runtime-auth.js";

function memoryStore(initial?: McpOAuthCredentialRecord): McpOAuthCredentialStore & { value?: McpOAuthCredentialRecord } {
  const store = {
    value: initial,
    get: async () => store.value,
    set: async (_name: string, value: McpOAuthCredentialRecord) => { store.value = value; },
    delete: async () => { const found = !!store.value; store.value = undefined; return found; },
    takeAndDelete: async () => { const previous = store.value; store.value = undefined; return previous; },
    readLogoutEpoch: async () => 0,
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

function loginFetch(options: { revocationEndpoint?: boolean; revoked?: string[]; captureResource?: string[] } = {}) {
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
    if (url === "https://auth.test/token") {
      const resource = new URLSearchParams(String(init?.body)).get("resource");
      if (resource) options.captureResource?.push(resource);
      return Response.json({ access_token: "access", refresh_token: "refresh", token_type: "Bearer", scope: "read" });
    }
    if (url === "https://auth.test/revoke") {
      options.revoked?.push(new URLSearchParams(String(init?.body)).get("token") ?? "");
      return new Response("", { status: 200 });
    }
    throw new Error(`Unexpected URL: ${url}`);
  }) as unknown as typeof globalThis.fetch;
}

describe("loginMcpOAuth", () => {
  it("cancels manual input when the loopback callback wins without cancelling token exchange", async () => {
    let authorization!: URL;
    let readerSignal: AbortSignal | undefined;
    let verified = false;
    const result = await loginMcpOAuth({ serverName: "linear", config: { type: "http", url: "https://mcp.test/mcp" }, scopes: ["read"], noBrowser: true, store: memoryStore() }, {
      fetch: loginFetch(),
      onAuthorizationUrl: value => { authorization = new URL(value); },
      readCallbackUrl: async (_prompt, signal) => {
        readerSignal = signal;
        const callback = new URL(authorization.searchParams.get("redirect_uri")!);
        callback.searchParams.set("state", authorization.searchParams.get("state")!);
        callback.searchParams.set("code", "browser-code");
        callback.searchParams.set("iss", "https://auth.test");
        await fetch(callback);
        return await new Promise<string>(() => undefined);
      },
      verifyConnection: async ({ signal }) => {
        expect(readerSignal?.aborted).toBe(true);
        expect(signal?.aborted).toBe(false);
        verified = true;
      },
    });
    expect(result.credential.tokens.accessToken).toBe("access");
    expect(verified).toBe(true);
  });
  it("preserves the committed candidate revision for refresh-retry diagnostics", async () => {
    let diagnostic: string | undefined;
    await expect(loginMcpOAuth({ serverName: "linear", config: { type: "http", url: "https://mcp.test/mcp" }, scopes: ["read"], store: memoryStore() }, {
      fetch: loginFetch(), callbackFactory: callbackFactory([]) as any,
      verifyConnection: async ({ store, config }) => {
        const runtime = new McpOAuthRuntime({ store, fetch: (async (request: string | URL | Request) =>
          String(request) === "https://auth.test/token"
            ? Response.json({ access_token: "rotated", refresh_token: "rotated-refresh", token_type: "Bearer", scope: "read" })
            : new Response("", { status: 401 })) as typeof fetch });
        await runtime.createFetch("linear", config)(config.url).catch(() => undefined);
        diagnostic = (await store.get("linear"))?.diagnostic?.code;
        throw new Error("server rejected candidate");
      },
    })).rejects.toMatchObject({ code: "oauth-login-verification-failed" });
    expect(diagnostic).toBe("reauthentication-required");
  });
  it("does not delete a new login when the explicitly supplied removed record was empty", async () => {
    const credential = revocationCredential();
    const store = memoryStore(credential);
    await revokeMcpOAuthCredential({ serverName: "linear", store, credential: undefined, fetch: loginFetch() });
    expect(store.value).toBe(credential);
  });

  it("allows another manual submission after an invalid callback", async () => {
    let authorization: URL;
    let inputs = 0;
    const rejected: string[] = [];
    const result = await loginMcpOAuth({ serverName: "linear", config: { type: "http", url: "https://mcp.test/mcp", oauth: { scopes: ["read"], callbackUrl: "https://app.example/callback" } }, store: memoryStore() }, {
      fetch: loginFetch(),
      onAuthorizationUrl: value => { authorization = new URL(value); },
      readCallbackUrl: async () => ++inputs === 1 ? "not a URL" : `https://app.example/callback?code=good&state=${authorization.searchParams.get("state")}&iss=https%3A%2F%2Fauth.test`,
      onCallbackRejected: error => { rejected.push(error.code); },
    });
    expect(rejected).toEqual(["oauth-callback-invalid"]);
    expect(result.credential.tokens.accessToken).toBe("access");
  });
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
    expect(result.credential.binding).toMatchObject({ configuredCallbackPort: null, configuredClientId: null });
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

  it("sends one verified resource indicator to authorization, token exchange and the binding", async () => {
    const store = memoryStore();
    const captureResource: string[] = [];
    let authorizeUrl: URL | undefined;

    const result = await loginMcpOAuth({
      serverName: "linear",
      config: { type: "http", url: "https://mcp.test/mcp", oauth: { scopes: ["read"], resourceUrl: "https://mcp.test/mcp" } },
      scopes: ["read"],
      store,
    }, {
      fetch: loginFetch({ captureResource }),
      callbackFactory: callbackFactory([]) as any,
      openBrowser: async (url) => { authorizeUrl = new URL(url); },
    });

    expect(authorizeUrl?.searchParams.get("resource")).toBe("https://mcp.test/mcp");
    expect(captureResource).toEqual(["https://mcp.test/mcp"]);
    expect(result.credential.binding.resourceUrl).toBe("https://mcp.test/mcp");
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

  it("rejects configuring both callbackUrl and callbackPort", async () => {
    await expect(loginMcpOAuth({
      serverName: "linear",
      config: { type: "http", url: "https://mcp.test/mcp", oauth: { scopes: ["read"], callbackPort: 43119, callbackUrl: "http://127.0.0.1:43119/cb" } },
      scopes: ["read"],
      store: memoryStore(),
    }, { fetch: loginFetch(), callbackFactory: callbackFactory([]) as any })).rejects.toMatchObject({
      code: "oauth-callback-config-conflict",
    });
  });

  it("notifies the authorization URL once and uses a manual HTTPS callback without opening a browser", async () => {
    const store = memoryStore();
    const notified: string[] = [];
    let authUrl: URL | undefined;
    let opened = 0;

    const result = await loginMcpOAuth({
      serverName: "linear",
      config: { type: "http", url: "https://mcp.test/mcp", oauth: { scopes: ["read"], callbackUrl: "https://app.example/callback" } },
      scopes: ["read"],
      store,
    }, {
      fetch: loginFetch(),
      onAuthorizationUrl: (url) => { notified.push(url); authUrl = new URL(url); },
      readCallbackUrl: async () =>
        `https://app.example/callback?code=code&state=${authUrl!.searchParams.get("state")}&iss=${encodeURIComponent("https://auth.test")}`,
      openBrowser: async () => { opened += 1; },
    });

    expect(notified).toHaveLength(1);
    expect(result.credential.tokens.accessToken).toBe("access");
    expect(result.credential.binding.redirectUri).toBe("https://app.example/callback");
    expect(opened).toBe(0);
  });

  it("revokes a provided credential without reading the shared store again", async () => {
    const store = memoryStore();
    store.get = async () => { throw new Error("the shared store must not be re-read after logout"); };
    const revoked: string[] = [];

    await revokeMcpOAuthCredential({
      serverName: "linear",
      store,
      credential: revocationCredential(),
      fetch: loginFetch({ revocationEndpoint: true, revoked }),
    });

    expect(revoked).toEqual(expect.arrayContaining(["refresh", "access"]));
  });

  it("atomically takes and deletes before revoking when no credential is provided", async () => {
    const store = memoryStore(revocationCredential());
    const revoked: string[] = [];

    await revokeMcpOAuthCredential({
      serverName: "linear",
      store,
      fetch: loginFetch({ revocationEndpoint: true, revoked }),
    });

    expect(store.value).toBeUndefined();
    expect(revoked).toEqual(expect.arrayContaining(["refresh", "access"]));
  });
});

function revocationCredential() {
  return {
    serverUrl: "https://mcp.test/mcp",
    revision: 1,
    binding: {
      issuer: "https://auth.test",
      redirectUri: "http://127.0.0.1:43119/oauth/callback",
      authorizationEndpoint: "https://auth.test/authorize",
      tokenEndpoint: "https://auth.test/token",
      revocationEndpoint: "https://auth.test/revoke",
    },
    registration: { client_id: "client", token_endpoint_auth_method: "none" },
    tokens: { accessToken: "access", refreshToken: "refresh", tokenType: "Bearer", scope: ["read"] },
  };
}

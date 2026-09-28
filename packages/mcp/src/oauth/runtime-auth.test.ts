import { describe, expect, it, vi } from "vitest";
import { InvalidGrantError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { McpOAuthCredentialRecord } from "@vykor/core";
import type { McpOAuthCredentialStore } from "./login.js";
import { McpOAuthRuntime } from "./runtime-auth.js";

function makeCredential(): McpOAuthCredentialRecord {
  return {
    serverUrl: "https://mcp.test/mcp",
    revision: 1,
    binding: { issuer: "https://auth.test", redirectUri: "http://127.0.0.1/cb", authorizationEndpoint: "https://auth.test/a", tokenEndpoint: "https://auth.test/token" },
    registration: { client_id: "c", token_endpoint_auth_method: "none" },
    tokens: { accessToken: "old", refreshToken: "refresh", tokenType: "Bearer", scope: ["read"], expiresAt: 1 },
  };
}

function memoryStore(initial?: McpOAuthCredentialRecord): McpOAuthCredentialStore {
  let value: McpOAuthCredentialRecord | undefined = initial;
  return {
    get: async () => value,
    list: async () => value ? { linear: value } : {},
    set: async (_name, next) => { value = next; },
    delete: async () => { const found = !!value; value = undefined; return found; },
    takeAndDelete: async () => { const previous = value; value = undefined; return previous; },
    readLogoutEpoch: async () => 0,
    update: async (_name, mutate) => (value = mutate(value)),
    runExclusive: async (_name, operation) => {
      const result = await operation(value, {
        nextRevision: (value?.revision ?? 0) + 1,
        logoutEpoch: 0,
      });
      if (result.next !== value) value = result.next;
      return result.result;
    },
  } as McpOAuthCredentialStore;
}

describe("McpOAuthRuntime", () => {
  it("uses a verified root fallback resource when no override was configured", async () => {
    const record = makeCredential();
    record.binding.resourceUrl = "https://mcp.test/";
    record.tokens.expiresAt = 200_000;
    const runtime = new McpOAuthRuntime({ store: memoryStore(record), clock: () => 100_000 });
    const config = { type: "http" as const, url: record.serverUrl };
    await expect(runtime.getAccessToken("linear", config)).resolves.toBe("old");
    await expect(runtime.getConnectionAction("linear", config)).resolves.toBe("connect");
  });

  it("does not mark a later login when the first request returns 401", async () => {
    const initial = makeCredential();
    initial.tokens.expiresAt = 200_000;
    initial.tokens.refreshToken = undefined;
    const store = memoryStore(initial);
    const newer = { ...initial, revision: 2, tokens: { ...initial.tokens, accessToken: "new-login", refreshToken: undefined } };
    const runtime = new McpOAuthRuntime({ store, clock: () => 100_000, fetch: (async () => {
      await store.set("linear", newer);
      return new Response("", { status: 401 });
    }) as typeof fetch });
    await expect(runtime.createFetch("linear", { type: "http", url: initial.serverUrl })(initial.serverUrl)).rejects.toBeDefined();
    expect((await store.get("linear"))?.diagnostic).toBeUndefined();
  });

  it("blocks credentials after the configured callback changes", async () => {
    const initial = makeCredential();
    initial.tokens.expiresAt = 200_000;
    const runtime = new McpOAuthRuntime({ store: memoryStore(initial), clock: () => 100_000 });
    await expect(runtime.getAccessToken("linear", { type: "http", url: initial.serverUrl, oauth: { callbackUrl: "https://new.test/cb" } })).rejects.toMatchObject({ code: "oauth-binding-changed" });
  });

  it.each([
    { configuredCallbackPort: 12345 },
    { configuredClientId: "configured-client" },
  ])("rejects removing an explicit registration setting: %j", async binding => {
    const record = makeCredential();
    Object.assign(record.binding, binding);
    record.tokens.expiresAt = 200_000;
    const runtime = new McpOAuthRuntime({ store: memoryStore(record), clock: () => 100_000 });
    const config = { type: "http" as const, url: record.serverUrl };
    await expect(runtime.getAccessToken("linear", config)).rejects.toMatchObject({ code: "oauth-binding-changed" });
    await expect(runtime.getConnectionAction("linear", config)).resolves.toBe("disconnect");
  });

  it("never invalidates a new login after an unauthenticated request", async () => {
    const record = makeCredential();
    record.tokens.expiresAt = 200_000;
    const store = memoryStore();
    const runtime = new McpOAuthRuntime({ store, fetch: (async () => {
      await store.set("linear", record);
      return new Response("", { status: 401 });
    }) as typeof fetch });
    await expect(runtime.createFetch("linear", { type: "http", url: record.serverUrl })(record.serverUrl)).rejects.toMatchObject({ code: "oauth-reauthentication-required" });
    expect((await store.get("linear"))?.diagnostic).toBeUndefined();
  });

  it("rejects removed resource overrides and changed fixed callback ports", async () => {
    const record = makeCredential();
    record.tokens.expiresAt = 200_000;
    record.binding.resourceUrl = "https://mcp.test/";
    record.binding.configuredResourceUrl = "https://mcp.test/";
    const runtime = new McpOAuthRuntime({ store: memoryStore(record), clock: () => 100_000 });
    await expect(runtime.getAccessToken("linear", { type: "http", url: record.serverUrl })).rejects.toMatchObject({ code: "oauth-binding-changed" });
    await expect(runtime.getAccessToken("linear", { type: "http", url: record.serverUrl, oauth: { resourceUrl: "https://mcp.test/", callbackPort: 12345 } })).rejects.toMatchObject({ code: "oauth-binding-changed" });
  });

  it("does not retry after the remote token rotated but storage commit failed", async () => {
    const store = memoryStore(makeCredential());
    const storageError = Object.assign(new Error("commit failed"), { name: "McpOAuthStoreError", code: "credential-storage-failed" });
    store.runExclusive = async (_name, operation) => {
      await operation(await store.get("linear"), { nextRevision: 2, logoutEpoch: 0 });
      throw storageError;
    };
    const tokenFetch = vi.fn(async () => Response.json({ access_token: "rotated", refresh_token: "rotated-refresh", token_type: "Bearer" }));
    const runtime = new McpOAuthRuntime({ store, fetch: tokenFetch as typeof fetch, clock: () => 100_000 });
    await expect(runtime.getAccessToken("linear", { type: "http", url: "https://mcp.test/mcp" })).rejects.toBe(storageError);
    expect(tokenFetch).toHaveBeenCalledTimes(1);
    expect((await store.get("linear"))?.diagnostic).toBeUndefined();
  });
  it.each([
    { label: "valid matching credential", credential: { ...makeCredential(), tokens: { ...makeCredential().tokens, expiresAt: 200_000 } }, config: { type: "http" as const, url: "https://mcp.test/mcp" }, want: "connect" },
    { label: "expired refreshable credential", credential: makeCredential(), config: { type: "http" as const, url: "https://mcp.test/mcp" }, want: "connect" },
    { label: "missing OAuth credential", credential: undefined, config: { type: "http" as const, url: "https://mcp.test/mcp", oauth: { scopes: ["read"] } }, want: "disconnect" },
    { label: "legacy logout without OAuth marker", credential: undefined, config: { type: "http" as const, url: "https://mcp.test/mcp" }, want: "disconnect" },
    { label: "credential bound to another endpoint", credential: makeCredential(), config: { type: "http" as const, url: "https://mcp.test/other" }, want: "disconnect" },
    { label: "reauthorization required", credential: { ...makeCredential(), diagnostic: { code: "reauthentication-required" as const, updatedAt: 1 } }, config: { type: "http" as const, url: "https://mcp.test/mcp" }, want: "disconnect" },
    { label: "explicit static bearer", credential: makeCredential(), config: { type: "http" as const, url: "https://mcp.test/mcp", headers: { Authorization: "Bearer static" } }, want: "ignore" },
    { label: "explicit custom authorization", credential: makeCredential(), config: { type: "http" as const, url: "https://mcp.test/mcp", headers: { Authorization: "Basic static" } }, want: "ignore" },
  ])("chooses $want for $label", async ({ credential, config, want }) => {
    const runtime = new McpOAuthRuntime({ store: memoryStore(credential), clock: () => 100_000 });

    await expect(runtime.getConnectionAction("linear", config)).resolves.toBe(want);
  });

  it("does not read the OAuth store for explicit static Authorization", async () => {
    const store = { get: vi.fn(async () => { throw new Error("credential store unavailable"); }) } as unknown as McpOAuthCredentialStore;
    const runtime = new McpOAuthRuntime({ store });

    await expect(runtime.getConnectionAction("linear", {
      type: "http", url: "https://mcp.test/mcp", headers: { Authorization: "Bearer static" },
    })).resolves.toBe("ignore");
    expect(store.get).not.toHaveBeenCalled();
  });

  it("disconnects after logout even when current settings cannot be read", async () => {
    const runtime = new McpOAuthRuntime({
      store: memoryStore(),
      getConfiguredOAuth: async () => { throw new Error("settings unavailable"); },
    });

    await expect(runtime.getConnectionAction("linear", {
      type: "http", url: "https://mcp.test/mcp", oauth: { scopes: ["read"] },
    })).resolves.toBe("disconnect");
  });

  it("blocks an active connection before sending an old token after configured scopes change", async () => {
    const store = memoryStore({ ...makeCredential(), tokens: { ...makeCredential().tokens, expiresAt: 200_000 } });
    let configuredScopes = ["read"];
    const fetch = vi.fn(async () => new Response("ok", { status: 200 }));
    const runtime = new McpOAuthRuntime({
      store,
      fetch: fetch as typeof globalThis.fetch,
      clock: () => 100_000,
      getConfiguredOAuth: async () => ({ scopes: configuredScopes }),
    });
    const config = { type: "http" as const, url: "https://mcp.test/mcp", oauth: { scopes: ["read"] } };
    const request = runtime.createFetch("linear", config);

    expect((await request(config.url)).status).toBe(200);
    configuredScopes = ["write"];
    await expect(request(config.url)).rejects.toMatchObject({
      code: "oauth-reauthentication-required",
      message: expect.stringContaining("vk mcp login linear"),
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(runtime.getConnectionAction("linear", config)).resolves.toBe("disconnect");

    await store.set("linear", { ...makeCredential(), tokens: { ...makeCredential().tokens, accessToken: "new", scope: ["write"], expiresAt: 200_000 } });
    expect((await request(config.url)).status).toBe(200);
    await expect(runtime.getConnectionAction("linear", config)).resolves.toBe("connect");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("coalesces refresh and rejects expanded refresh scopes", async () => {
    const store = memoryStore(makeCredential());
    const fetch = vi.fn(async () => new Response(JSON.stringify({ access_token: "new", refresh_token: "new-refresh", token_type: "Bearer", scope: "read write" }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof globalThis.fetch;
    const runtime = new McpOAuthRuntime({ store, fetch, clock: () => 100_000 });
    const config = { type: "http" as const, url: "https://mcp.test/mcp", oauth: { scopes: ["read"] } };
    await expect(Promise.all([runtime.getAccessToken("linear", config), runtime.getAccessToken("linear", config)])).rejects.toMatchObject({ code: "oauth-scope-expansion" });
    expect(fetch).toHaveBeenCalledTimes(1);
    // A scope expansion is a security rejection, not a stale credential: the
    // old record must not be cross-marked as permanently invalid.
    expect((await store.get("linear"))?.diagnostic).toBeUndefined();
  });

  it("refreshes and retries one 401 at the fetch layer", async () => {
    const store = memoryStore({ ...makeCredential(), tokens: { ...makeCredential().tokens, expiresAt: 200_000 } });
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response("unauthorized", { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "fresh", token_type: "Bearer", scope: "read" }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const runtime = new McpOAuthRuntime({ store, fetch: fetch as typeof globalThis.fetch, clock: () => 100_000 });
    const response = await runtime.createFetch("linear", { type: "http", url: "https://mcp.test/mcp" })("https://mcp.test/mcp");
    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  describe("refresh failure classification", () => {
    const tokenRequest = { type: "http" as const, url: "https://mcp.test/mcp", oauth: { scopes: ["read"] } };

    async function refreshWith(fetchImpl: typeof globalThis.fetch) {
      const store = memoryStore(makeCredential());
      const runtime = new McpOAuthRuntime({ store, fetch: fetchImpl, clock: () => 100_000 });
      const error = await runtime.getAccessToken("linear", tokenRequest).then(
        () => undefined,
        (thrown: unknown) => thrown,
      );
      return { error, record: await store.get("linear") };
    }

    it.each([
      { label: "network failure", fetch: (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof globalThis.fetch },
      { label: "HTTP 429", fetch: (async () => new Response(JSON.stringify({ error: "too_many_requests" }), { status: 429, headers: { "content-type": "application/json" } })) as unknown as typeof globalThis.fetch },
      { label: "HTTP 503 server_error", fetch: (async () => new Response(JSON.stringify({ error: "server_error" }), { status: 503, headers: { "content-type": "application/json" } })) as unknown as typeof globalThis.fetch },
      { label: "HTTP 503 misleading invalid_grant", fetch: (async () => Response.json({ error: "invalid_grant" }, { status: 503 })) as typeof globalThis.fetch },
      { label: "HTTP 429 misleading invalid_grant", fetch: (async () => Response.json({ error: "invalid_grant" }, { status: 429 })) as typeof globalThis.fetch },
      { label: "timeout", fetch: (async () => { throw new Error("socket timeout"); }) as unknown as typeof globalThis.fetch },
      { label: "plain invalid_grant message", fetch: (async () => { throw new Error("invalid_grant"); }) as unknown as typeof globalThis.fetch },
    ])("keeps the credential on $label", async ({ fetch }) => {
      const before = makeCredential();
      const { error, record } = await refreshWith(fetch);
      expect(error).toMatchObject({ code: "oauth-refresh-failed", retryable: true });
      expect(record).toEqual(before);
      expect(record?.diagnostic).toBeUndefined();
    });

    it("invalidates only on a structured invalid_grant error", async () => {
      const before = makeCredential();
      const { error, record } = await refreshWith((async () => {
        throw new InvalidGrantError("refresh token is invalid");
      }) as unknown as typeof globalThis.fetch);
      expect(error).toMatchObject({ code: "oauth-reauthentication-required" });
      expect(record?.tokens).toEqual(before.tokens);
      expect(record?.revision).toBe(before.revision);
      expect(record?.diagnostic?.code).toBe("reauthentication-required");
    });

    it("does not invalidate the credential when the refresh is cancelled", async () => {
      const store = memoryStore(makeCredential());
      const controller = new AbortController();
      controller.abort(new Error("cancelled by user"));
      const fetch = vi.fn(async (_input: unknown, init?: RequestInit) => {
        if (init?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      }) as unknown as typeof globalThis.fetch;
      const runtime = new McpOAuthRuntime({ store, fetch, clock: () => 100_000 });

      await expect(runtime.getAccessToken("linear", tokenRequest, controller.signal)).rejects.toBeDefined();
      const record = await store.get("linear");
      expect(record?.diagnostic).toBeUndefined();
      expect(record?.tokens.accessToken).toBe("old");
    });
  });
});

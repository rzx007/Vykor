import { describe, expect, it, vi } from "vitest";
import type { McpOAuthCredentialRecord } from "@openharness/core";
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
    update: async (_name, mutate) => (value = mutate(value)),
    runExclusive: async (_name, operation) => {
      const result = await operation(value);
      value = result.next;
      return result.result;
    },
  } as McpOAuthCredentialStore;
}

describe("McpOAuthRuntime", () => {
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

  it("coalesces refresh and rejects expanded refresh scopes", async () => {
    const store = memoryStore(makeCredential());
    const fetch = vi.fn(async () => new Response(JSON.stringify({ access_token: "new", refresh_token: "new-refresh", token_type: "Bearer", scope: "read write" }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof globalThis.fetch;
    const runtime = new McpOAuthRuntime({ store, fetch, clock: () => 100_000 });
    const config = { type: "http" as const, url: "https://mcp.test/mcp", oauth: { scopes: ["read"] } };
    await expect(Promise.all([runtime.getAccessToken("linear", config), runtime.getAccessToken("linear", config)])).rejects.toMatchObject({ code: "oauth-scope-expansion" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await store.get("linear"))?.diagnostic?.code).toBe("reauthentication-required");
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
});

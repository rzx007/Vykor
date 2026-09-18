import { describe, expect, it, vi } from "vitest";
import type { McpOAuthCredentialRecord } from "@openharness/core";
import type { OAuthCallbackController } from "./callback.js";
import { loginMcpOAuth, type McpOAuthCredentialStore } from "./login.js";

function memoryStore(): McpOAuthCredentialStore & { value?: McpOAuthCredentialRecord } {
  const store = {
    value: undefined as McpOAuthCredentialRecord | undefined,
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

describe("loginMcpOAuth", () => {
  it("binds the final callback before DCR and persists only approved scopes", async () => {
    const store = memoryStore();
    const events: string[] = [];
    let expectedIssuer = "";
    const callbackFactory = vi.fn(async (options: { expectedIssuer: string }) => {
      expectedIssuer = options.expectedIssuer;
      events.push("callback");
      return {
        redirectUri: "http://127.0.0.1:43119/oauth/callback",
        wait: async () => ({ code: "code", issuer: expectedIssuer }),
        accept: async () => ({ code: "code", issuer: expectedIssuer }),
        close: async () => undefined,
      } as OAuthCallbackController;
    });
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://mcp.test/mcp") return new Response("", { status: 401, headers: { "www-authenticate": "Bearer resource_metadata=\"https://mcp.test/.well-known/oauth-protected-resource/mcp\"" } });
      if (url.includes("oauth-protected-resource")) return Response.json({ resource: "https://mcp.test/mcp", authorization_servers: ["https://auth.test"], scopes_supported: ["read", "write"] });
      if (url.includes("oauth-authorization-server")) return Response.json({ issuer: "https://auth.test", authorization_endpoint: "https://auth.test/authorize", token_endpoint: "https://auth.test/token", registration_endpoint: "https://auth.test/register", response_types_supported: ["code"], code_challenge_methods_supported: ["S256"], authorization_response_iss_parameter_supported: true });
      if (url === "https://auth.test/register") {
        events.push(`dcr:${JSON.parse(String(init?.body)).redirect_uris[0]}`);
        return Response.json({ client_id: "client", redirect_uris: ["http://127.0.0.1:43119/oauth/callback"], token_endpoint_auth_method: "none" });
      }
      if (url === "https://auth.test/token") return Response.json({ access_token: "access", refresh_token: "refresh", token_type: "Bearer", scope: "read" });
      throw new Error(`Unexpected URL: ${url}`);
    }) as unknown as typeof globalThis.fetch;

    const result = await loginMcpOAuth({
      serverName: "linear",
      config: { type: "http", url: "https://mcp.test/mcp" },
      scopes: ["read"],
      store,
    }, { fetch, callbackFactory: callbackFactory as any, openBrowser: async () => undefined, verifyConnection: async () => undefined });

    expect(events).toEqual(["callback", "dcr:http://127.0.0.1:43119/oauth/callback"]);
    expect(result).toEqual({ status: "valid", scopes: ["read"], verified: true });
    expect(store.value?.tokens).toMatchObject({ accessToken: "access", scope: ["read"] });
  });
});

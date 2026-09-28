import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { McpOAuthCredentialStore } from "@vykor/auth";
import type { Settings } from "@vykor/core";
import { loginMcpOAuth, McpOAuthRuntime, revokeMcpOAuthCredential, verifyMcpOAuthConnection } from "@vykor/mcp";
import { McpOAuthApplicationService } from "./mcp-oauth-application-service.js";
import { McpOAuthOperationService } from "./mcp-oauth-operation-service.js";
import { createMcpRoutes } from "../http/routes/mcp.js";

// Integrates the real SDK discovery/code exchange/MCP verification, file store,
// application, operation service and HTTP routes. Only the external provider's
// fetch boundary and settings location are controlled; no real account is used.
it("authorizes through the operation API, retries invalid manual input and logs out the stored credential", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mcp-oauth-flow-"));
  const store = new McpOAuthCredentialStore(join(directory, "credentials.json"));
  const endpoint = "https://mcp.example.test/mcp";
  const issuer = "https://auth.example.test/";
  let settings = {
    mcpServers: { demo: { type: "http", url: endpoint, oauth: {
      scopes: ["read"], clientId: "test-client", callbackUrl: "https://callback.example.test/oauth",
    } } },
  } as Settings;
  const grants: URLSearchParams[] = [];
  const revoked: string[] = [];
  const verifiedMethods: string[] = [];
  const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json" },
  });
  const providerFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.href === endpoint) {
      if (request.headers.get("authorization") !== "Bearer test-access-secret") {
        return new Response(null, { status: 401, headers: {
          "www-authenticate": 'Bearer resource_metadata="https://mcp.example.test/.well-known/oauth-protected-resource/mcp"',
        } });
      }
      if (request.method !== "POST") return new Response(null, { status: 405 });
      const message = await request.json() as { id?: number; method: string; params?: { protocolVersion?: string } };
      verifiedMethods.push(message.method);
      if (message.id === undefined) return new Response(null, { status: 202 });
      return response({ jsonrpc: "2.0", id: message.id, result: message.method === "initialize"
        ? { protocolVersion: message.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
        : { tools: [] } });
    }
    if (url.href === "https://mcp.example.test/.well-known/oauth-protected-resource/mcp") {
      return response({ resource: endpoint, authorization_servers: [issuer], scopes_supported: ["read"] });
    }
    if (url.href === `${issuer}.well-known/oauth-authorization-server`) {
      return response({ issuer, authorization_endpoint: `${issuer}authorize`, token_endpoint: `${issuer}token`,
        revocation_endpoint: `${issuer}revoke`, response_types_supported: ["code"], code_challenge_methods_supported: ["S256"] });
    }
    if (url.href === `${issuer}token`) {
      grants.push(new URLSearchParams(await request.text()));
      return response({ access_token: "test-access-secret", refresh_token: "test-refresh-secret", token_type: "Bearer", scope: "read", expires_in: 3600 });
    }
    if (url.href === `${issuer}revoke`) {
      revoked.push(new URLSearchParams(await request.text()).get("token")!);
      return new Response(null, { status: 200 });
    }
    return response({}, 404);
  };
  const sync = { status: "connected" as const, affectedRuntimes: 1, failures: [] };
  const coordinator = { getStatus: async () => sync, synchronize: async () => sync, reconcileGlobal: async () => sync };
  const application = new McpOAuthApplicationService({
    loadSettings: async () => settings,
    updateSettings: async (change) => (settings = await change(settings)),
    credentialStore: store,
    coordinator,
    login: (input, deps) => loginMcpOAuth(input, { ...deps, fetch: providerFetch }),
    verify: (input) => verifyMcpOAuthConnection({ ...input, runtime: new McpOAuthRuntime({ store: input.store, fetch: providerFetch }) }),
    revoke: (input) => revokeMcpOAuthCredential({ ...input, fetch: providerFetch }),
  });
  const operations = new McpOAuthOperationService({ application, instanceId: "fixture-instance" });
  const app = createMcpRoutes({ oauth: application, operations, runtimes: coordinator });
  const post = (path: string, body: unknown) => app.request(path, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  try {
    const input = { oauthInstanceId: "fixture-instance", requestId: "request-1", callbackMode: "manual", scopes: ["read"] };
    const created = await post("/demo/oauth/login", input);
    expect(created.status).toBe(202);
    const { loginId } = await created.json() as { loginId: string };
    expect(await (await post("/demo/oauth/login", input)).json()).toMatchObject({ loginId });
    let authorization!: URL;
    await vi.waitFor(async () => {
      const view = await (await app.request(`/oauth/operations/${loginId}`)).json() as { authorizationUrl?: string; state: string };
      expect(view.state).toBe("pending");
      expect(view.authorizationUrl).toBeDefined();
      authorization = new URL(view.authorizationUrl!);
    });
    expect(authorization.searchParams.get("resource")).toBe(endpoint);
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
    const callback = new URL(authorization.searchParams.get("redirect_uri")!);
    callback.searchParams.set("code", "test-code-secret");
    callback.searchParams.set("state", "wrong-state");
    const invalid = await post(`/oauth/operations/${loginId}/callback`, { callbackUrl: callback.href });
    expect(invalid.status).toBe(400);
    expect(operations.get(loginId)?.state).toBe("pending");
    callback.searchParams.set("state", authorization.searchParams.get("state")!);
    expect((await post(`/oauth/operations/${loginId}/callback`, { callbackUrl: callback.href })).status).toBe(200);
    await vi.waitFor(() => expect(operations.get(loginId)?.state).toBe("completed"));
    expect(grants).toHaveLength(1);
    expect(grants[0]!.get("resource")).toBe(endpoint);
    expect(grants[0]!.get("redirect_uri")).toBe("https://callback.example.test/oauth");
    expect(grants[0]!.get("code_verifier")).toBeTruthy();
    expect(verifiedMethods).toContain("initialize");
    expect(verifiedMethods).toContain("tools/list");
    expect((await store.get("demo"))?.tokens.accessToken).toBe("test-access-secret");
    const completed = await app.request(`/oauth/operations/${loginId}`);
    const view = await completed.json();
    expect(view).toMatchObject({ credentialCommitted: true, runtimeSync: sync });
    const events = await (await app.request(`/oauth/operations/${loginId}/events`)).text();
    expect(events).toContain("mcp.oauth.login.completed");
    for (const secret of ["test-access-secret", "test-refresh-secret", "test-code-secret", authorization.href]) {
      expect(events).not.toContain(secret);
      expect(JSON.stringify(view)).not.toContain(secret);
    }
    expect((await post("/demo/oauth/logout", {})).status).toBe(200);
    expect(await store.get("demo")).toBeUndefined();
    expect(await store.readLogoutEpoch("demo")).toBe(1);
    expect(revoked.sort()).toEqual(["test-access-secret", "test-refresh-secret"]);
  } finally {
    await operations.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);

import { describe, expect, it, vi } from "vitest";
import type { McpRuntimeSyncResult, McpServerIdentity } from "@vykor/core";
import { McpOAuthOperationService } from "../../application/mcp-oauth-operation-service.js";
import { McpOAuthApplicationError } from "../../application/mcp-oauth-application-service.js";
import { createMcpRoutes } from "./mcp.js";

const fingerprint = "A".repeat(43);

function fixture(result: McpRuntimeSyncResult = { status: "unavailable", affectedRuntimes: 0, failures: [] }) {
  const seen: McpServerIdentity[] = [];
  const reconciled: string[] = [];
  const runtimes = {
    getStatus: vi.fn(async (identity: McpServerIdentity) => { seen.push(identity); return result; }),
    synchronize: vi.fn(async (identity: McpServerIdentity) => { seen.push(identity); return result; }),
    reconcileGlobal: vi.fn(async (name: string) => { reconciled.push(name); return result; }),
  };
  return { runtimes, seen, reconciled, app: createMcpRoutes({ runtimes }) };
}

describe("MCP runtime control routes", () => {
  it("reads runtime status by name and endpoint fingerprint", async () => {
    const { app, runtimes, seen } = fixture({ status: "connected", affectedRuntimes: 2, failures: [] });

    const response = await app.request(`/linear/runtime-status?fingerprint=${fingerprint}`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "connected", affectedRuntimes: 2, failures: [] });
    expect(runtimes.getStatus).toHaveBeenCalledTimes(1);
    expect(seen[0]).toMatchObject({ name: "linear", transport: "http", endpointFingerprint: fingerprint });
  });

  it("synchronizes by name and endpoint fingerprint", async () => {
    const { app, runtimes } = fixture({ status: "connected", affectedRuntimes: 1, failures: [] });

    const response = await app.request("/linear/synchronize", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fingerprint }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "connected", affectedRuntimes: 1, failures: [] });
    expect(runtimes.synchronize).toHaveBeenCalledTimes(1);
  });

  it("rejects missing or malformed fingerprints without calling the coordinator", async () => {
    const { app, runtimes } = fixture();

    expect((await app.request("/linear/runtime-status")).status).toBe(400);
    expect((await app.request("/linear/runtime-status?fingerprint=short")).status).toBe(400);
    expect((await app.request("/linear/synchronize", { method: "POST", body: JSON.stringify({}) })).status).toBe(400);
    expect((await app.request("/linear/synchronize", { method: "POST", body: "not json" })).status).toBe(400);
    expect(runtimes.getStatus).not.toHaveBeenCalled();
    expect(runtimes.synchronize).not.toHaveBeenCalled();
  });

  it("returns the coordinator result even when no runtime is available", async () => {
    const { app } = fixture();
    const response = await app.request(`/linear/runtime-status?fingerprint=${fingerprint}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "unavailable", affectedRuntimes: 0, failures: [] });
  });

  it("reconciles global configuration by name without a fingerprint", async () => {
    const { app, runtimes, reconciled } = fixture({ status: "connected", affectedRuntimes: 1, failures: [] });

    const response = await app.request("/local/reconcile-global", { method: "POST" });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "connected", affectedRuntimes: 1, failures: [] });
    expect(runtimes.reconcileGlobal).toHaveBeenCalledWith("local");
    expect(reconciled).toEqual(["local"]);
  });

  it("never echoes the full endpoint or any token in the response", async () => {
    const { app } = fixture({
      status: "error",
      affectedRuntimes: 1,
      failures: [{ runtimeId: "runtime-1", message: "reconnect failed" }],
    });
    const text = await (await app.request(`/linear/synchronize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fingerprint }),
    })).text();

    expect(text).not.toContain("https://");
    expect(text).not.toContain("Bearer");
    expect(text).not.toContain("tenant=");
  });
});

describe("MCP OAuth operation routes", () => {
  function oauthFixture() {
    const application = {
      beginLogin: vi.fn((input: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
        input.signal?.addEventListener("abort", () => reject(input.signal?.reason), { once: true });
      })),
    };
    const operations = new McpOAuthOperationService({ application: application as never, instanceId: "inst-1" });
    const oauth = {
      snapshot: vi.fn(async () => ({ servers: [] })),
      logout: vi.fn(async () => ({ servers: [] })),
    };
    const app = createMcpRoutes({ runtimes: {} as never, oauth, operations });
    return { app, operations, oauth, application };
  }

  it("reads the authenticated status snapshot with no-store", async () => {
    const { app, oauth } = oauthFixture();
    const response = await app.request("/oauth/status");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ servers: [] });
    expect(oauth.snapshot).toHaveBeenCalledTimes(1);
  });

  it("validates login input before creating an operation", async () => {
    const { app, application } = oauthFixture();

    const invalid = await app.request("/linear/oauth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId: "r", callbackMode: "local" }),
    });
    expect(invalid.status).toBe(400);

    const conflict = await app.request("/linear/oauth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ oauthInstanceId: "other", requestId: "r", callbackMode: "local" }),
    });
    expect(conflict.status).toBe(409);
    expect(application.beginLogin).not.toHaveBeenCalled();
  });

  it("creates, reads, cancels and streams one operation", async () => {
    const { app, operations } = oauthFixture();
    const created = await app.request("/linear/oauth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ oauthInstanceId: "inst-1", requestId: "r1", callbackMode: "local" }),
    });
    expect(created.status).toBe(202);
    const body = await created.json() as { loginId: string; operation: { state: string } };
    expect(body.operation.state).toBe("pending");

    expect((await app.request(`/oauth/operations/${body.loginId}`)).status).toBe(200);
    expect((await app.request("/oauth/operations/missing")).status).toBe(404);

    const cancelled = await app.request(`/oauth/operations/${body.loginId}`, { method: "DELETE" });
    expect(await cancelled.json()).toMatchObject({ state: "cancelled" });

    const events = await app.request(`/oauth/operations/${body.loginId}/events`);
    const text = await events.text();
    expect(text).toContain("event: mcp.oauth.login.completed");
    expect(text).toContain("\"state\":\"cancelled\"");
    void operations;
  });

  it("rejects a submitted callback for a local operation", async () => {
    const { app } = oauthFixture();
    const created = await app.request("/linear/oauth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ oauthInstanceId: "inst-1", requestId: "r1", callbackMode: "local" }),
    });
    const { loginId } = await created.json() as { loginId: string };
    const response = await app.request(`/oauth/operations/${loginId}/callback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ callbackUrl: "https://app.example/cb?code=c" }),
    });
    expect(response.status).toBe(400);
  });

  it("releases the subscription when the SSE response is cancelled", async () => {
    const { app, operations } = oauthFixture();
    const { view } = operations.begin({ oauthInstanceId: "inst-1", requestId: "r", name: "linear", callbackMode: "local" });
    const subscribe = operations.subscribe.bind(operations);
    let active = 0;
    vi.spyOn(operations, "subscribe").mockImplementation((id, listener) => {
      active += 1;
      const unsubscribe = subscribe(id, listener);
      return () => { active -= 1; unsubscribe(); };
    });
    const response = await app.request(`/oauth/operations/${view.loginId}/events`);
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    expect(active).toBe(0);
    await operations.close();
  });

  it("logs out and returns the fresh snapshot", async () => {
    const { app, oauth } = oauthFixture();
    const response = await app.request("/linear/oauth/logout", { method: "POST" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ servers: [] });
    expect(oauth.logout).toHaveBeenCalledWith("linear");
  });

  it("reports a runtime logout failure without hiding the successful credential removal", async () => {
    const { app, oauth } = oauthFixture();
    oauth.logout.mockRejectedValueOnce(new McpOAuthApplicationError("oauth-removed-runtime-sync-failed", "untrusted secret"));
    const response = await app.request("/linear/oauth/logout", { method: "POST" });
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ code: "oauth-removed-runtime-sync-failed", credentialRemoved: true });
  });

  it("returns 501 for OAuth routes when the daemon has no OAuth services", async () => {
    const { app } = fixture();
    expect((await app.request("/oauth/status")).status).toBe(501);
    expect((await app.request("/linear/oauth/login", { method: "POST", body: "{}" })).status).toBe(501);
  });
});

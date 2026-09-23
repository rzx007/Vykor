import { describe, expect, it, vi } from "vitest";
import type { McpRuntimeSyncResult, McpServerIdentity } from "@openharness/core";
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

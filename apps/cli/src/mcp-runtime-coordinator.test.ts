import { describe, expect, it, vi } from "vitest";
import { IncompatibleProtocolError, OpenHarnessApiError } from "@openharness/client";
import type { McpRuntimeSyncResult, McpServerIdentity } from "@openharness/core";
import { createCliMcpRuntimeCoordinator } from "./mcp-runtime-coordinator.js";

const identity: McpServerIdentity = {
  name: "linear",
  transport: "http",
  endpoint: "https://mcp.linear.app/mcp",
  endpointFingerprint: "A".repeat(43),
};

const connected: McpRuntimeSyncResult = { status: "connected", affectedRuntimes: 1, failures: [] };

function fixture(options: {
  registry?: { url: string; token: string } | undefined;
  statusResult?: McpRuntimeSyncResult;
  syncResult?: McpRuntimeSyncResult;
  statusError?: unknown;
  syncError?: unknown;
} = {}) {
  const runtimeStatus = vi.fn(async () => {
    if (options.statusError) throw options.statusError;
    return options.statusResult ?? connected;
  });
  const synchronize = vi.fn(async () => {
    if (options.syncError) throw options.syncError;
    return options.syncResult ?? connected;
  });
  const createClient = vi.fn(() => ({ mcp: { runtimeStatus, synchronize } }));
  const coordinator = createCliMcpRuntimeCoordinator({
    readRegistry: () => ("registry" in options ? options.registry : { url: "http://127.0.0.1:1234", token: "tok" }),
    createClient: createClient as never,
  });
  return { coordinator, createClient, runtimeStatus, synchronize };
}

describe("createCliMcpRuntimeCoordinator", () => {
  it("calls the daemon control plane through the typed client", async () => {
    const { coordinator, createClient, runtimeStatus, synchronize } = fixture();

    await expect(coordinator.getStatus(identity)).resolves.toEqual(connected);
    await expect(coordinator.synchronize(identity)).resolves.toEqual(connected);

    expect(createClient).toHaveBeenCalledWith({ baseUrl: "http://127.0.0.1:1234", token: "tok" });
    expect(runtimeStatus).toHaveBeenCalledWith("linear", "A".repeat(43));
    expect(synchronize).toHaveBeenCalledWith("linear", "A".repeat(43));
  });

  it("returns unavailable when the daemon registry is absent", async () => {
    const { coordinator, createClient } = fixture({ registry: undefined });

    await expect(coordinator.getStatus(identity)).resolves.toEqual({ status: "unavailable", affectedRuntimes: 0, failures: [] });
    await expect(coordinator.synchronize(identity)).resolves.toEqual({ status: "unavailable", affectedRuntimes: 0, failures: [] });
    expect(createClient).not.toHaveBeenCalled();
  });

  it("returns unavailable when the daemon connection is refused", async () => {
    const refused = new TypeError("fetch failed");
    (refused as { cause?: unknown }).cause = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    const { coordinator } = fixture({ statusError: refused });

    await expect(coordinator.getStatus(identity)).resolves.toEqual({ status: "unavailable", affectedRuntimes: 0, failures: [] });
  });

  it("reports daemon authentication errors instead of pretending the daemon is offline", async () => {
    const { coordinator } = fixture({ syncError: new OpenHarnessApiError("Unauthorized", 401, { error: "Unauthorized" }) });

    await expect(coordinator.synchronize(identity)).rejects.toBeInstanceOf(OpenHarnessApiError);
  });

  it("reports protocol incompatibility instead of pretending the daemon is offline", async () => {
    const { coordinator } = fixture({ syncError: new IncompatibleProtocolError({ serverVersion: "x", protocol: { version: 1 }, features: {} } as never, "protocol mismatch") });

    await expect(coordinator.synchronize(identity)).rejects.toBeInstanceOf(IncompatibleProtocolError);
  });

  it("reports a daemon 5xx as a sync failure", async () => {
    const { coordinator } = fixture({ syncError: new OpenHarnessApiError("Internal Server Error", 500, { error: "boom" }) });

    await expect(coordinator.synchronize(identity)).rejects.toBeInstanceOf(OpenHarnessApiError);
  });
});

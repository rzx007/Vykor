import { describe, expect, it, vi } from "vitest"
import {
  IncompatibleProtocolError,
  OpenHarnessApiError,
  type McpRuntimeSyncResult,
} from "@openharness/client"
import { createDesktopMcpRuntimeCoordinator } from "./mcp-runtime-coordinator"

const identity = {
  name: "linear",
  transport: "http" as const,
  endpoint: "https://mcp.linear.app/mcp",
  endpointFingerprint: "A".repeat(43),
}

const connected: McpRuntimeSyncResult = {
  status: "connected",
  affectedRuntimes: 1,
  failures: [],
}

function fixture(options: {
  registry?: { url: string; token: string } | undefined
  syncError?: unknown
} = {}) {
  const runtimeStatus = vi.fn(async () => connected)
  const synchronize = vi.fn(async () => {
    if (options.syncError) throw options.syncError
    return connected
  })
  const createClient = vi.fn(() => ({ mcp: { runtimeStatus, synchronize } }))
  const coordinator = createDesktopMcpRuntimeCoordinator({
    readRegistry: () =>
      "registry" in options ? options.registry : { url: "http://127.0.0.1:1234", token: "tok" },
    createClient: createClient as never,
  })
  return { coordinator, createClient, runtimeStatus, synchronize }
}

describe("createDesktopMcpRuntimeCoordinator", () => {
  it("calls the daemon control plane through the typed client", async () => {
    const { coordinator, createClient } = fixture()
    await expect(coordinator.synchronize(identity)).resolves.toEqual(connected)
    expect(createClient).toHaveBeenCalledWith({ baseUrl: "http://127.0.0.1:1234", token: "tok" })
  })

  it("returns unavailable when the daemon registry is absent", async () => {
    const { coordinator, createClient } = fixture({ registry: undefined })
    await expect(coordinator.synchronize(identity)).resolves.toEqual({
      status: "unavailable",
      affectedRuntimes: 0,
      failures: [],
    })
    expect(createClient).not.toHaveBeenCalled()
  })

  it("reports daemon authentication errors instead of pretending the daemon is offline", async () => {
    const { coordinator } = fixture({
      syncError: new OpenHarnessApiError("Unauthorized", 401, { error: "Unauthorized" }),
    })
    await expect(coordinator.synchronize(identity)).rejects.toBeInstanceOf(OpenHarnessApiError)
  })

  it("reports protocol incompatibility instead of pretending the daemon is offline", async () => {
    const { coordinator } = fixture({
      syncError: new IncompatibleProtocolError({} as never, "protocol mismatch"),
    })
    await expect(coordinator.synchronize(identity)).rejects.toBeInstanceOf(
      IncompatibleProtocolError
    )
  })
})

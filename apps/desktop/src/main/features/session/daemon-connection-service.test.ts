import { beforeEach, describe, expect, it, vi } from "vitest"

const clientState = vi.hoisted(() => ({ fail: false, hang: false }))

const daemonHost = vi.hoisted(() => ({
  readDaemonRegistry: vi.fn(),
  writeDaemonRegistry: vi.fn(),
  clearDaemonRegistry: vi.fn(),
  createBearerToken: vi.fn(() => "token"),
  startOpenHarnessDaemon: vi.fn(),
}))

vi.mock("electron", () => ({
  app: { getVersion: () => "1.0.0", getPath: () => "D:/documents" },
  BrowserWindow: { getAllWindows: () => [] },
}))

vi.mock("@openharness/server/daemon-host", () => daemonHost)

vi.mock("@openharness/client", () => ({
  OpenHarnessClient: class {
    protocol = {
      health: async () => {
        if (clientState.hang) return await new Promise(() => {})
        if (clientState.fail) throw new Error("boom")
      },
    }
    projects = {
      list: async () => {
        if (clientState.hang) return await new Promise(() => {})
        if (clientState.fail) throw new Error("boom")
      },
    }
  },
}))

import { DaemonConnectionService } from "./daemon-connection-service"

function registry(pid = 4242) {
  return {
    url: "http://127.0.0.1:5555",
    pid,
    token: "tok",
    storePath: "D:/db",
    startedAt: 1,
    version: "1.0.0",
  }
}

const embedded = {
  server: { store: { path: "D:/db" }, close: vi.fn() },
  listen: { url: "http://127.0.0.1:6666" },
}

beforeEach(() => {
  vi.clearAllMocks()
  clientState.fail = false
  clientState.hang = false
})

describe("DaemonConnectionService ownership safety", () => {
  it("keeps the registry and does NOT start an embedded daemon when the registered daemon process is still alive", async () => {
    daemonHost.readDaemonRegistry.mockReturnValue(registry())
    clientState.fail = true

    const service = new DaemonConnectionService({ pidAlive: () => true })

    await expect(service.getClient()).rejects.toThrow(/pid 4242.*unreachable/i)
    expect(daemonHost.clearDaemonRegistry).not.toHaveBeenCalled()
    expect(daemonHost.startOpenHarnessDaemon).not.toHaveBeenCalled()
  })

  it("reclaims the registry and starts an embedded daemon when the registered daemon process is dead", async () => {
    daemonHost.readDaemonRegistry.mockReturnValue(registry())
    daemonHost.startOpenHarnessDaemon.mockResolvedValue(embedded)
    clientState.fail = true

    const service = new DaemonConnectionService({ pidAlive: () => false })

    await expect(service.getClient()).resolves.toBeDefined()
    expect(daemonHost.clearDaemonRegistry).toHaveBeenCalledTimes(1)
    expect(daemonHost.startOpenHarnessDaemon).toHaveBeenCalledTimes(1)
    expect(daemonHost.writeDaemonRegistry).toHaveBeenCalledTimes(1)
  })

  it("connects to a healthy registered daemon without starting an embedded one", async () => {
    daemonHost.readDaemonRegistry.mockReturnValue(registry())

    const service = new DaemonConnectionService({ pidAlive: () => true })

    await expect(service.getClient()).resolves.toBeDefined()
    expect(daemonHost.startOpenHarnessDaemon).not.toHaveBeenCalled()
  })

  it("starts an embedded daemon when no registry exists", async () => {
    daemonHost.readDaemonRegistry.mockReturnValue(undefined)
    daemonHost.startOpenHarnessDaemon.mockResolvedValue(embedded)

    const service = new DaemonConnectionService()

    await expect(service.getClient()).resolves.toBeDefined()
    expect(daemonHost.startOpenHarnessDaemon).toHaveBeenCalledTimes(1)
  })

  it("allows a later retry after a transient connect failure instead of caching the rejection", async () => {
    daemonHost.readDaemonRegistry.mockReturnValue(registry())
    clientState.fail = true

    const service = new DaemonConnectionService({ pidAlive: () => true })
    await expect(service.getClient()).rejects.toThrow()
    expect(daemonHost.startOpenHarnessDaemon).not.toHaveBeenCalled()

    clientState.fail = false
    await expect(service.getClient()).resolves.toBeDefined()
  })

  it("honors the configured verification timeout instead of hanging", async () => {
    daemonHost.readDaemonRegistry.mockReturnValue(registry())
    clientState.hang = true

    const service = new DaemonConnectionService({ pidAlive: () => true, verifyTimeoutMs: 20 })

    await expect(service.getClient()).rejects.toThrow(/timed out/i)
    expect(daemonHost.startOpenHarnessDaemon).not.toHaveBeenCalled()
  })
})

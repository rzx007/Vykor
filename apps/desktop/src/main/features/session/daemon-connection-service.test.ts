import { beforeEach, describe, expect, it, vi } from "vitest"
import type { DaemonRegistry } from "@vykor/server/daemon-host"

const clientState = vi.hoisted(() => ({ fail: false, hang: false }))

const daemonHost = vi.hoisted(() => ({
  readDaemonRegistry: vi.fn(),
  writeDaemonRegistry: vi.fn(),
  clearDaemonRegistry: vi.fn(),
  createBearerToken: vi.fn(() => "token"),
  createDaemonRegistryEntry: vi.fn((input: unknown) => input),
  startVykorDaemon: vi.fn(),
  shouldStartManagedDaemon: vi.fn(async () => false),
}))

vi.mock("electron", () => ({
  app: { getVersion: () => "1.0.0", getPath: () => "D:/documents" },
  BrowserWindow: { getAllWindows: () => [] },
}))

vi.mock("@vykor/server/daemon-host", () => daemonHost)

vi.mock("../daemon-autostart/daemon-surface", () => ({
  isDesktopManagedRegistry: (r: { executionSurface?: string }) =>
    r.executionSurface === "desktop_managed",
}))
vi.mock("../daemon-autostart/daemon-takeover", () => ({
  stopNonDesktopDaemon: vi.fn(async () => undefined),
  reconcileDesktopManagedService: vi.fn(async () => undefined),
}))

vi.mock("@vykor/client", () => ({
  VykorClient: class {
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

function registry(overrides: Partial<DaemonRegistry> = {}): DaemonRegistry {
  return {
    url: "http://127.0.0.1:5555",
    pid: 4242,
    token: "tok",
    storePath: "D:/db",
    startedAt: 1,
    version: "1.0.0",
    executionSurface: "desktop_managed",
    ...overrides,
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
    expect(daemonHost.startVykorDaemon).not.toHaveBeenCalled()
  })

  it("reclaims the registry and starts an embedded daemon when the registered daemon process is dead", async () => {
    daemonHost.readDaemonRegistry.mockReturnValue(registry())
    daemonHost.startVykorDaemon.mockResolvedValue(embedded)
    clientState.fail = true

    const service = new DaemonConnectionService({ pidAlive: () => false })

    await expect(service.getClient()).resolves.toBeDefined()
    expect(daemonHost.clearDaemonRegistry).toHaveBeenCalledTimes(1)
    expect(daemonHost.startVykorDaemon).toHaveBeenCalledTimes(1)
    expect(daemonHost.writeDaemonRegistry).toHaveBeenCalledTimes(1)
  })

  it("connects to a healthy desktop-managed daemon without starting an embedded one", async () => {
    daemonHost.readDaemonRegistry.mockReturnValue(registry())

    const service = new DaemonConnectionService({ pidAlive: () => true })

    await expect(service.getClient()).resolves.toBeDefined()
    expect(daemonHost.startVykorDaemon).not.toHaveBeenCalled()
  })

  it("starts an embedded daemon when no registry exists", async () => {
    daemonHost.readDaemonRegistry.mockReturnValue(undefined)
    daemonHost.startVykorDaemon.mockResolvedValue(embedded)

    const service = new DaemonConnectionService()

    await expect(service.getClient()).resolves.toBeDefined()
    expect(daemonHost.startVykorDaemon).toHaveBeenCalledTimes(1)
  })

  it("allows a later retry after a transient connect failure instead of caching the rejection", async () => {
    daemonHost.readDaemonRegistry.mockReturnValue(registry())
    clientState.fail = true

    const service = new DaemonConnectionService({ pidAlive: () => true })
    await expect(service.getClient()).rejects.toThrow()
    expect(daemonHost.startVykorDaemon).not.toHaveBeenCalled()

    clientState.fail = false
    await expect(service.getClient()).resolves.toBeDefined()
  })

  it("honors the configured verification timeout instead of hanging", async () => {
    daemonHost.readDaemonRegistry.mockReturnValue(registry())
    clientState.hang = true

    const service = new DaemonConnectionService({ pidAlive: () => true, verifyTimeoutMs: 20 })

    await expect(service.getClient()).rejects.toThrow(/timed out/i)
    expect(daemonHost.startVykorDaemon).not.toHaveBeenCalled()
  })

  it("restarts an ephemeral CLI daemon when autoStart is off", async () => {
    daemonHost.readDaemonRegistry.mockReturnValue(registry({ executionSurface: "cli_advanced" }))
    daemonHost.startVykorDaemon.mockResolvedValue(embedded)
    const stop = vi.fn(async () => undefined)

    const service = new DaemonConnectionService({
      pidAlive: () => true,
      shouldAutoStart: async () => false,
      stopNonDesktopDaemon: stop,
    })

    await expect(service.getClient()).resolves.toBeDefined()
    expect(stop).toHaveBeenCalledOnce()
    expect(daemonHost.startVykorDaemon).toHaveBeenCalledOnce()
    expect(daemonHost.writeDaemonRegistry).toHaveBeenCalledWith(
      expect.objectContaining({ executionSurface: "desktop_managed" })
    )
  })

  it("reconciles the OS service when autoStart is on", async () => {
    const reconcile = vi.fn(async () => undefined)
    daemonHost.readDaemonRegistry
      .mockReturnValueOnce(registry({ executionSurface: "cli_advanced" }))
      .mockReturnValue(registry())

    const service = new DaemonConnectionService({
      pidAlive: () => true,
      shouldAutoStart: async () => true,
      reconcileDesktopService: reconcile,
    })

    await expect(service.getClient()).resolves.toBeDefined()
    expect(reconcile).toHaveBeenCalledOnce()
    expect(daemonHost.startVykorDaemon).not.toHaveBeenCalled()
  })
})

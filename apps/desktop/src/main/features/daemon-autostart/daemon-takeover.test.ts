import { beforeEach, describe, expect, it, vi } from "vitest"
import type { DaemonRegistry } from "@openharness/server/daemon-host"

const host = vi.hoisted(() => ({
  readDaemonRegistry: vi.fn(),
  clearDaemonRegistry: vi.fn(),
  stopDaemonProcess: vi.fn(async () => undefined),
}))

vi.mock("electron", () => ({ app: { isPackaged: true } }))
vi.mock("@openharness/server/daemon-host", () => host)
vi.mock("./daemon-autostart-service", () => ({
  createDesktopDaemonSystemService: () => ({ uninstall: vi.fn(), install: vi.fn() }),
}))

import { isDesktopManagedRegistry, isLoopbackDaemonUrl } from "./daemon-surface"
import {
  stopNonDesktopDaemon,
  waitForDesktopManagedRegistry,
} from "./daemon-takeover"

function registry(overrides: Partial<DaemonRegistry> = {}): DaemonRegistry {
  return {
    url: "http://127.0.0.1:5555",
    pid: 42,
    token: "tok",
    storePath: "db",
    startedAt: 1,
    version: "1.0.0",
    executionSurface: "cli_advanced",
    ...overrides,
  }
}

beforeEach(() => vi.clearAllMocks())

describe("daemon takeover helpers", () => {
  it("recognizes only desktop-managed registries", () => {
    expect(isDesktopManagedRegistry(registry())).toBe(false)
    expect(isDesktopManagedRegistry(registry({ executionSurface: "desktop_managed" }))).toBe(true)
    expect(isDesktopManagedRegistry({ executionSurface: undefined })).toBe(false)
  })

  it("recognizes loopback urls", () => {
    expect(isLoopbackDaemonUrl("http://127.0.0.1:1")).toBe(true)
    expect(isLoopbackDaemonUrl("http://localhost:1")).toBe(true)
    expect(isLoopbackDaemonUrl("http://10.0.0.5:1")).toBe(false)
  })

  it("refuses to stop a non-loopback daemon", async () => {
    await expect(stopNonDesktopDaemon(registry({ url: "http://10.0.0.5:1" }))).rejects.toThrow(/loopback/i)
    expect(host.stopDaemonProcess).not.toHaveBeenCalled()
  })

  it("stops and clears the registry entry for a loopback daemon", async () => {
    await stopNonDesktopDaemon(registry())
    expect(host.stopDaemonProcess).toHaveBeenCalledWith(42)
    expect(host.clearDaemonRegistry).toHaveBeenCalledOnce()
  })

  it("waits for a healthy desktop-managed registry", async () => {
    host.readDaemonRegistry.mockReturnValue(registry({ executionSurface: "desktop_managed" }))
    const found = await waitForDesktopManagedRegistry({
      isHealthy: async () => true,
      timeoutMs: 500,
    })
    expect(found.pid).toBe(42)
  })

  it("times out when no desktop-managed registry appears", async () => {
    host.readDaemonRegistry.mockReturnValue(registry())
    await expect(
      waitForDesktopManagedRegistry({ isHealthy: async () => true, timeoutMs: 50 }),
    ).rejects.toThrow(/did not become ready/i)
  })
})

import { describe, expect, it, vi } from "vitest"
import type { DaemonRegistry } from "@openharness/server/daemon-host"

vi.mock("electron", () => ({
  app: {
    isPackaged: true,
    getAppPath: () => "D:/app",
    getVersion: () => "1.0.0",
    getPath: () => "D:/documents",
  },
}))
import { registeredDaemonHealthy, resolveDesktopDaemonMode } from "./daemon-entry"

describe("desktop daemon entry", () => {
  it("recognizes only fixed headless flags", () => {
    expect(resolveDesktopDaemonMode(["OpenHarness", "--daemon-service"])).toBe("service")
    expect(resolveDesktopDaemonMode(["OpenHarness", "--daemon-watchdog"])).toBe("watchdog")
    expect(resolveDesktopDaemonMode(["OpenHarness"])).toBeNull()
  })

  it("treats a cli_advanced registry as not adoptable", async () => {
    const registry: DaemonRegistry = {
      url: "http://127.0.0.1:1",
      pid: 1,
      token: "t",
      storePath: "db",
      startedAt: 1,
      version: "1.0.0",
      executionSurface: "cli_advanced",
    }
    const healthy = await registeredDaemonHealthy(
      () => registry,
      async () => new Response("{}", { status: 200 })
    )
    expect(healthy).toBe(false)
  })

  it("treats a healthy desktop-managed registry as adoptable", async () => {
    const registry: DaemonRegistry = {
      url: "http://127.0.0.1:1",
      pid: 1,
      token: "t",
      storePath: "db",
      startedAt: 1,
      version: "1.0.0",
      executionSurface: "desktop_managed",
    }
    const healthy = await registeredDaemonHealthy(
      () => registry,
      async () => new Response("{}", { status: 200 })
    )
    expect(healthy).toBe(true)
  })
})

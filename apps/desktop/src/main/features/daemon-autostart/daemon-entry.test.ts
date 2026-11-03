import { afterEach, describe, expect, it, vi } from "vitest"
import type { DaemonRegistry } from "@vykor/server/daemon-host"
import { setHostResponseLocale } from "@vykor/server/daemon-host"
const hostLanguage = vi.hoisted(() => ({ value: undefined as string | undefined }))

vi.mock("electron", () => ({
  app: {
    isPackaged: true,
    getAppPath: () => "D:/app",
    getVersion: () => "1.0.0",
    getPath: () => "D:/documents",
    getPreferredSystemLanguages: () => ["zh-Hans-CN", "en-US"],
  },
}))
vi.mock("@vykor/server/daemon-host", async (importOriginal) => {
  const original = await importOriginal<typeof import("@vykor/server/daemon-host")>()
  return {
    ...original,
    readDaemonRegistry: () => undefined,
    clearDaemonRegistry: () => {},
    setHostResponseLocale: (locale: string | undefined) => {
      hostLanguage.value = locale
      original.setHostResponseLocale(locale)
    },
    startVykorDaemon: async () => {
      throw new Error(`test-stop:${hostLanguage.value}`)
    },
  }
})
import { registeredDaemonHealthy, resolveDesktopDaemonMode, runDesktopDaemonEntry } from "./daemon-entry"

afterEach(() => setHostResponseLocale(undefined))

describe("desktop daemon entry", () => {
  it("binds the preferred display language before starting the daemon", async () => {
    await expect(runDesktopDaemonEntry("service")).rejects.toThrow("test-stop:zh-Hans-CN")
  })
  it("recognizes only fixed headless flags", () => {
    expect(resolveDesktopDaemonMode(["Vykor", "--daemon-service"])).toBe("service")
    expect(resolveDesktopDaemonMode(["Vykor", "--daemon-watchdog"])).toBe("watchdog")
    expect(resolveDesktopDaemonMode(["Vykor"])).toBeNull()
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

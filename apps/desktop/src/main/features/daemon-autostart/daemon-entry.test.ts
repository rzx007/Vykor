import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"

const host = vi.hoisted(() => ({
  runRegisteredDaemon: vi.fn(async () => {}),
  setHostResponseLocale: vi.fn(),
  readDaemonRegistry: vi.fn(),
  daemonPidAlive: vi.fn(),
  shouldStartManagedDaemon: vi.fn(async () => false),
  isWindowsDaemonServiceEnabled: vi.fn(async () => false),
}))

vi.mock("electron", () => ({
  app: {
    isPackaged: true, getVersion: () => "1.0.0", getPath: () => "D:/documents",
    getPreferredSystemLanguages: () => ["zh-Hans-CN", "en-US"],
  },
}))
vi.mock("@vykor/server/daemon-host", () => host)

import { resolveDesktopDaemonMode, runDesktopDaemonEntry } from "./daemon-entry"

describe("desktop daemon entry", () => {
  it.each([["service", true], ["on-demand", false]] as const)(
    "uses the same registered runtime for %s with the correct supervision",
    async (mode, supervised) => {
      host.runRegisteredDaemon.mockClear()
      host.setHostResponseLocale.mockClear()
      await runDesktopDaemonEntry(mode)
      expect(host.setHostResponseLocale).toHaveBeenCalledWith("zh-Hans-CN")
      expect(host.runRegisteredDaemon).toHaveBeenCalledWith(expect.objectContaining({
        launcher: "desktop", version: "1.0.0", supervised,
        outsideProjectWorkspaceRoot: join(process.env.VYKOR_CONFIG_DIR!, "workspaces"),
        channelsWorkspaceRoot: join(process.env.VYKOR_CONFIG_DIR!, "channels"),
        ...(mode === "service" && process.platform === "win32"
          ? { shouldStart: host.isWindowsDaemonServiceEnabled }
          : {}),
      }))
      expect(host.setHostResponseLocale.mock.invocationCallOrder[0])
        .toBeLessThan(host.runRegisteredDaemon.mock.invocationCallOrder[0]!)
    },
  )

  it("recognizes only fixed headless flags", () => {
    expect(resolveDesktopDaemonMode(["Vykor", "--daemon-service"])).toBe("service")
    expect(resolveDesktopDaemonMode(["Vykor", "--daemon-watchdog"])).toBe("watchdog")
    expect(resolveDesktopDaemonMode(["Vykor", "--daemon-on-demand"])).toBe("on-demand")
    expect(resolveDesktopDaemonMode(["Vykor"])).toBeNull()
  })

  it("does not launch a replacement for a live registration", async () => {
    host.readDaemonRegistry.mockReturnValue({ pid: 42 })
    host.daemonPidAlive.mockReturnValue(true)
    host.shouldStartManagedDaemon.mockClear()
    await runDesktopDaemonEntry("watchdog")
    expect(host.daemonPidAlive).toHaveBeenCalledWith(42)
    expect(host.shouldStartManagedDaemon).not.toHaveBeenCalled()
  })
})

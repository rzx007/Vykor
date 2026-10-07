import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

let directory = ""
const { shown, mode, sessionGet } = vi.hoisted(() => ({ shown: vi.fn(), mode: { value: "show" }, sessionGet: vi.fn() }))
vi.mock("node:child_process", () => ({ execFile: (_command: unknown, _args: unknown, _options: unknown, callback: (error: null, stdout: string, stderr: string) => void) => callback(null, "Enabled REG_DWORD 0x1", "") }))
vi.mock("electron", () => ({
  app: { getPath: () => directory, isPackaged: false }, shell: { openExternal: vi.fn(async () => {}) },
  Notification: class {
    static isSupported() { return true }
    listeners = new Map<string, () => void>()
    once(name: string, callback: () => void) { this.listeners.set(name, callback) }
    removeAllListeners() { this.listeners.clear() }
    show() { shown(); this.listeners.get(mode.value)?.() }
  },
}))
vi.mock("../session/session-service", () => ({ desktopSessionService: { daemonClient: async () => ({ sessions: { get: sessionGet } }) } }))

describe("notification settings", () => {
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "vykor-notifications-")); mode.value = "show"; shown.mockClear(); sessionGet.mockReset() })
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); vi.resetModules() })

  it("persists each event switch without changing sounds and rejects stale writes", async () => {
    const { desktopNotificationSettingsService: service } = await import("./notification-settings-service")
    const { patchDesktopPreferences, getDesktopPreferences } = await import("./desktop-preferences")
    patchDesktopPreferences({ notificationSounds: { completed: "none", failed: "nope-03", needs_input: "none" } })
    const initial = await service.snapshot()
    await service.updateEvents({ events: { completed: false, failed: true, needs_input: false }, expectedEvents: initial.events })
    expect((await service.snapshot()).events).toEqual({ completed: false, failed: true, needs_input: false })
    expect(getDesktopPreferences().notificationSounds).toEqual({ completed: "none", failed: "nope-03", needs_input: "none" })
    await expect(service.updateEvents({ events: initial.events, expectedEvents: initial.events })).rejects.toThrow("其他窗口")
  })

  it("reports the native notification's show and failure events rather than claiming success on submission", async () => {
    const { desktopNotificationSettingsService: service } = await import("./notification-settings-service")
    expect(await service.test()).toMatchObject({ status: "shown" })
    mode.value = "failed"
    expect(await service.test()).toMatchObject({ status: "failed" })
    expect(shown).toHaveBeenCalledTimes(2)
  })

  it("distinguishes missing sessions from connection failures when opening a notification", async () => {
    const { desktopNotificationSettingsService: service } = await import("./notification-settings-service")
    sessionGet.mockRejectedValueOnce({ status: 404, message: "missing" })
    await expect(service.resolveSession("deleted")).resolves.toBeNull()
    sessionGet.mockRejectedValueOnce(new Error("ECONNREFUSED"))
    await expect(service.resolveSession("offline")).rejects.toThrow("ECONNREFUSED")
    sessionGet.mockResolvedValueOnce({ id: "existing", projectId: "p1" })
    await expect(service.resolveSession("existing")).resolves.toEqual({ id: "existing", projectId: "p1" })
  })
})

import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { DEFAULT_TERMINAL_SETTINGS } from "../../../shared/terminal-settings-types"

let directory = ""
vi.mock("electron", () => ({
  app: { getPath: () => directory },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`encrypted:${value}`),
    decryptString: (value: Buffer) => value.toString().replace(/^encrypted:/, ""),
  },
}))

describe("terminal settings persistence", () => {
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "vykor-terminal-settings-")) })
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); vi.resetModules() })

  it("rejects stale revisions without overwriting confirmed settings", async () => {
    const { desktopTerminalSettingsService: service } = await import("./terminal-settings-service")
    const initial = service.snapshot()
    const saved = service.update({ settings: { ...initial.settings, fontSize: 19 }, expectedRevision: initial.revision, defaultTerminalShellId: null })
    expect(saved.settings.fontSize).toBe(19)
    expect(() => service.update({ settings: { ...initial.settings, fontSize: 12 }, expectedRevision: initial.revision, defaultTerminalShellId: null })).toThrow("其他窗口")
    expect(service.snapshot().settings.fontSize).toBe(19)
  })

  it("stores only encrypted secret values and reuses redacted values without leaking them in snapshots", async () => {
    const { desktopTerminalSettingsService: service } = await import("./terminal-settings-service")
    const initial = service.snapshot()
    const saved = service.update({ settings: { ...DEFAULT_TERMINAL_SETTINGS, environment: [{ name: "TOKEN", secret: true, value: "secret-value" }, { name: "MODE", secret: false, value: "terminal" }] }, expectedRevision: initial.revision, defaultTerminalShellId: null })
    const disk = await readFile(join(directory, "desktop-preferences.json"), "utf8")
    expect(disk).not.toContain("secret-value")
    expect(saved.settings.environment[0]).toEqual({ name: "TOKEN", value: "", secret: true, hasValue: true })
    service.update({ settings: { ...saved.settings, fontSize: 16 }, expectedRevision: saved.revision, defaultTerminalShellId: null })
    expect(service.launchEnvironment()).toEqual({ TOKEN: "secret-value", MODE: "terminal" })
    expect(process.env.TOKEN).not.toBe("secret-value")
  })

  it("rejects invalid dimensions and variables before persisting anything", async () => {
    const { desktopTerminalSettingsService: service } = await import("./terminal-settings-service")
    const initial = service.snapshot()
    for (const invalid of [{ fontSize: 25 }, { scrollback: 999 }, { wslShell: "cmd.exe" }, { environment: [{ name: "BAD=NAME", value: "x", secret: false }] }]) {
      expect(() => service.update({ settings: { ...initial.settings, ...invalid }, expectedRevision: initial.revision, defaultTerminalShellId: null })).toThrow()
    }
    expect(service.snapshot().revision).toBe(initial.revision)
  })

  it("reports an unavailable migrated Shell instead of silently selecting a different one", async () => {
    const { patchDesktopPreferences } = await import("./desktop-preferences")
    patchDesktopPreferences({ defaultTerminalShellId: "removed-shell" })
    const { desktopTerminalSettingsService: service } = await import("./terminal-settings-service")
    expect(service.snapshot()).toMatchObject({ defaultTerminalShellId: "removed-shell", shellError: expect.stringContaining("未检测到") })
  })
})

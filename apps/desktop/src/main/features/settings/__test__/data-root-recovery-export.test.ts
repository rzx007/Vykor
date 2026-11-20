import { mkdir, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { MaintenanceSettingsChannels } from "../../../../shared/maintenance-settings-types"

const shell = vi.hoisted(() => ({
  launches: [] as string[][],
  dialog: async (_options: unknown): Promise<{ response: number }> => { throw new Error("Unexpected host recovery dialog") },
  recover: async (_journal: string, _options: { homeDir: string }): Promise<Record<string, unknown>> => { throw new Error("Unexpected disk recovery") },
}))
vi.mock("electron", () => ({ app: { isPackaged: false, getAppPath: () => "owned-desktop-entry", getPath: (name: string) => join(process.env.USERPROFILE!, name),
  relaunch: ({ args }: { args: string[] }) => shell.launches.push(args), quit: () => {} }, dialog: { showMessageBox: (options: unknown) => shell.dialog(options) } }))
vi.mock("@vykor/server/daemon-host", () => ({ recoverDataRootMigration: (journal: string, options: { homeDir: string }) => shell.recover(journal, options) }))
vi.mock("../git-settings-storage", () => ({ getGitSettings: () => ({}) }))
afterEach(() => vi.useRealTimers())

async function desktop(options: { savedOtherRoot?: boolean; selectorOnly?: boolean; environmentOnly?: boolean } = {}) {
  vi.resetModules()
  shell.launches.length = 0
  shell.dialog = async () => { throw new Error("Unexpected host recovery dialog") }
  const paths = await import("@vykor/host-config/paths")
  const homeDir = process.env.USERPROFILE!, root = join(homeDir, "recover-owned-root")
  await mkdir(root, { recursive: true })
  process.env.VYKOR_CONFIG_DIR = root
  process.env.VYKOR_DATA_DIR = join(root, "data")
  process.env.VYKOR_CHANNELS_DIR = join(root, "channels")
  process.env.VYKOR_IMAGE_ATTACHMENT_CACHE_DIR = join(root, "cache", "images")
  await rm(paths.dataRootSelectorPath(homeDir), { force: true })
  // Saved-root admission checks require an existing database; these tests never open its body.
  await mkdir(join(root, "data", "session-runtime"), { recursive: true })
  await writeFile(join(root, "data", "session-runtime", "sessions.db"), "owned existing database fixture")
  if (options.savedOtherRoot || options.selectorOnly) await paths.writeDataRootSelector(homeDir, {
    version: 1, dataRoot: options.savedOtherRoot ? join(homeDir, "unrelated-saved-root") : root,
  })
  await paths.initializeDataRoot({ homeDir, ...(options.selectorOnly || options.environmentOnly ? {} : { explicitRoot: root }),
    env: options.environmentOnly ? { VYKOR_CONFIG_DIR: root } : {} })
  const gate = await import("../../../core/ipc/operation-gate"), windows = await import("../../business-data/window-flush")
  const settings = await import("../data-root-settings-service"), business = await import("../../business-data/business-data-service")
  const { wrapIpcHandler } = await import("../../../core/ipc/wrap-handler")
  const { dataRootSettingsIpcContribution } = await import("../data-root-settings-ipc")
  const operation = dataRootSettingsIpcContribution.register({} as never).find(entry => entry.channel === MaintenanceSettingsChannels.recoverDataRoot)!
  const invoke = wrapIpcHandler("data-root-settings", operation.channel, operation.handler)
  const writer = await paths.acquireDataRootWriter({ homeDir, dataRoot: root, kind: "desktop" })
  gate.setDesktopRootWriter(writer)
  settings.setDataRootMaintenanceMode()
  let destroy!: () => void
  const renderer = { frozen: false, fail: true, beforeAck: async () => {}, draft: "owned in-memory draft" }
  const sender = { id: 2001, isDestroyed: () => false, once: (_event: string, callback: () => void) => { destroy = callback },
    send: (event: string, id: string, freeze: boolean) => {
      if (event === "business-data:export-resumed") { renderer.frozen = false; return }
      renderer.frozen = freeze
      void (async () => {
        await renderer.beforeAck()
        if (!renderer.fail) await business.desktopBusinessDataService.recordDesktopScan({}, { userDataDir: join(homeDir, "userData"), documentsDir: join(homeDir, "documents") })
        await gate.desktopOperationGate.run("business-data:flush-ack", () => windows.acknowledgeBusinessDataFlush(sender.id, id, !renderer.fail))
      })()
    } }
  windows.trackBusinessDataWindow(sender as never); windows.markBusinessDataWindowReady(sender.id)
  const journal = join(homeDir, "owned-journal.json")
  return { paths, homeDir, root, gate, settings, renderer, journal, recover: () => Promise.resolve(invoke({ sender } as never, journal)),
    cleanup: async () => { destroy(); await writer.release() } }
}

// Catches the missing failure cleanup: a real failed renderer ACK must reopen unchanged source IPC.
it("resumes the unchanged unsealed source after recovery export failure and permits a successful IPC retry", async () => {
  const d = await desktop()
  try {
    await expect(d.recover()).rejects.toThrow("FLUSH_FAILED")
    expect(d.renderer.frozen).toBe(false)
    expect(d.renderer.draft).toBe("owned in-memory draft")
    expect(d.settings.isDataRootMigrationShutdown()).toBe(false)
    await expect(d.gate.desktopOperationGate.run("session:send-prompt", () => "retry available")).resolves.toBe("retry available")
    d.renderer.fail = false
    vi.useFakeTimers()
    await expect(d.recover()).resolves.toMatchObject({ phase: "restarting-for-recovery" })
    await vi.runAllTimersAsync()
    expect(shell.launches).toEqual([["owned-desktop-entry", "data-root", "recover", "--journal", d.journal]])
    await expect(d.gate.desktopOperationGate.run("business-data:write", () => {})).rejects.toThrow(/迁移/)
  } finally { await d.cleanup() }
})

it.each(["explicit", "environment"])("resumes the %s startup root even when an unrelated saved selector names another root", async source => {
  const d = await desktop({ savedOtherRoot: true, environmentOnly: source === "environment" })
  try {
    await expect(d.recover()).rejects.toThrow("FLUSH_FAILED")
    expect(d.renderer.frozen).toBe(false)
    await expect(d.gate.desktopOperationGate.run("session:send-prompt", () => "retry available")).resolves.toBe("retry available")
    expect(d.paths.readDataRootSelector(d.homeDir)?.dataRoot).toBe(join(d.homeDir, "unrelated-saved-root"))
  } finally { await d.cleanup() }
})

it.each(["pending", "unknown-selector", "changed-source"])("retains the freeze with %s and keeps native host recovery usable", async scenario => {
  const d = await desktop()
  const original = join(d.homeDir, "original-root")
  let entered!: () => void, respond!: (choice: { response: number }) => void
  const dialogEntered = new Promise<void>(resolve => { entered = resolve })
  let dialogCount = 0, recoveryAttempts = 0
  shell.dialog = async () => {
    if (++dialogCount > 1 && scenario === "pending") return { response: 0 }
    entered(); return new Promise(resolve => { respond = resolve })
  }
  d.renderer.beforeAck = async () => {
    if (scenario === "pending") await d.paths.writeDataRootSelector(d.homeDir, { version: 1, dataRoot: d.root, pendingMigration: { id: "owned", journalPath: d.journal } })
    if (scenario === "unknown-selector") await writeFile(d.paths.dataRootSelectorPath(d.homeDir), "invalid")
    if (scenario === "changed-source") { await rename(d.root, original); await mkdir(d.root) }
  }
  // Recovery is the external boundary; selector reads, identity checks, IPC and window flush stay real.
  shell.recover = async () => {
    if (++recoveryAttempts === 1) throw new Error("owned retryable recovery failure")
    await d.paths.writeDataRootSelector(d.homeDir, { version: 1, dataRoot: d.root })
    return { phase: "failed", recoveryWritersReleased: true }
  }
  const pending = d.recover()
  const outcome = pending.then(value => ({ value, error: undefined }), error => ({ value: undefined, error }))
  try {
    await Promise.race([dialogEntered, pending])
    expect(d.renderer.frozen).toBe(true)
    await expect(d.gate.desktopOperationGate.run("session:send-prompt", () => {})).rejects.toThrow(/迁移/)
    expect(d.settings.isDataRootMigrationShutdown()).toBe(false)
    if (scenario === "unknown-selector") await rm(d.paths.dataRootSelectorPath(d.homeDir))
    if (scenario === "changed-source") { await rm(d.root, { recursive: true }); await rename(original, d.root) }
    respond({ response: scenario === "pending" ? 0 : 1 })
    expect((await outcome).error).toHaveProperty("message", "business-data window FLUSH_FAILED")
    expect(d.renderer.frozen).toBe(false)
    await expect(d.gate.desktopOperationGate.run("session:send-prompt", () => "restored")).resolves.toBe("restored")
    expect(shell.launches).toEqual([])
  } finally { await d.cleanup() }
})

it("never resumes sealed IPC when releasing the old writer fails after a successful export", async () => {
  const d = await desktop()
  d.renderer.fail = false
  d.gate.setDesktopRootWriter({ release: async () => { throw new Error("owned release failure") } })
  try {
    await expect(d.recover()).rejects.toThrow("owned release failure")
    expect(d.renderer.frozen).toBe(true)
    expect(d.settings.isDataRootMigrationShutdown()).toBe(true)
    await expect(d.gate.desktopOperationGate.run("business-data:write", () => {})).rejects.toThrow(/迁移/)
  } finally { await d.cleanup() }
})

it.each(["selection-changed", "moved-marker"])("does not reopen an unchanged directory when %s makes the startup selection unsafe", async scenario => {
  const d = await desktop({ selectorOnly: scenario === "selection-changed" })
  let entered!: () => void, respond!: (choice: { response: number }) => void
  const dialogEntered = new Promise<void>(resolve => { entered = resolve })
  shell.dialog = async () => { entered(); return new Promise(resolve => { respond = resolve }) }
  const marker = d.paths.movedDataRootMarkerPath(d.root)
  d.renderer.beforeAck = async () => {
    if (scenario === "selection-changed") await d.paths.writeDataRootSelector(d.homeDir, { version: 1, dataRoot: join(d.homeDir, "new-effective-root") })
    else { await mkdir(join(d.root, "data", "migrations"), { recursive: true }); await writeFile(marker, "owned moved marker") }
  }
  const pending = d.recover()
  const outcome = pending.then(value => ({ value, error: undefined }), error => ({ value: undefined, error }))
  try {
    await Promise.race([dialogEntered, pending])
    expect(d.renderer.frozen).toBe(true)
    await expect(d.gate.desktopOperationGate.run("session:send-prompt", () => {})).rejects.toThrow(/迁移/)
    if (scenario === "selection-changed") await d.paths.writeDataRootSelector(d.homeDir, { version: 1, dataRoot: d.root })
    else await rm(marker)
    respond({ response: 0 })
    expect((await outcome).error).toHaveProperty("message", "business-data window FLUSH_FAILED")
    expect(d.renderer.frozen).toBe(false)
  } finally { await d.cleanup() }
})

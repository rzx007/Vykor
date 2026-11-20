import { join } from "node:path"
import { expect, it, vi, afterEach } from "vitest"
const script = vi.hoisted(() => ({ recoverAfterFailedExport: false, result: { phase: "committed", journalPath: "", writersReleased: true, startup: "ready" } as Record<string, unknown>, launches: [] as Array<{ args: string[]; config: string | undefined }> }))
vi.mock("electron", () => ({ app: { isPackaged: false, getAppPath: () => "owned-desktop-entry", getPath: (name: string) => join(process.env.USERPROFILE!, name),
  relaunch: ({ args }: { args: string[] }) => script.launches.push({ args, config: process.env.VYKOR_CONFIG_DIR }), quit: () => {} }, dialog: { showMessageBox: async () => ({ response: 0 }) } }))
vi.mock("@vykor/server/daemon-host", async importOriginal => ({ ...await importOriginal<object>(),
  inspectDataRootMigration: async (input: { sourceRoot: string; targetRoot: string }) => ({ ...input, sources: [], databases: [], blockers: [] }),
  migrateDataRootAndRestart: async (_input: unknown, options: { prepareDesktop(): Promise<unknown> }) => {
    try { await options.prepareDesktop() }
    catch (error) { if (!script.recoverAfterFailedExport) throw error; return { id: "owned", phase: "failed", writersReleased: false, recoveryWritersReleased: true, startup: "not-started", journalPath: "owned-recovered-journal" } }
    return { id: "owned", ...script.result }
  },
}))
afterEach(() => vi.useRealTimers())

it.each(["committed", "failed"])("restarts a sealed %s result with fresh startup arguments and the original environment", async phase => {
  vi.resetModules()
  // Each parameter runs with its own module graph, as a new Desktop process would.
  const paths = await import("@vykor/host-config/paths")
  const root = process.env.VYKOR_CONFIG_DIR!, homeDir = process.env.USERPROFILE!, target = join(homeDir, `target-${phase}`)
  await paths.initializeDataRoot({ homeDir, explicitRoot: root, env: { HOME: homeDir, USERPROFILE: homeDir } })
  const gate = await import("../../../core/ipc/operation-gate")
  gate.setDesktopRootWriter(await paths.acquireDataRootWriter({ homeDir, dataRoot: root, kind: "desktop" }))
  const business = await import("../../business-data/business-data-service"), windows = await import("../../business-data/window-flush")
  const host = { userDataDir: join(homeDir, "userData"), documentsDir: join(homeDir, "documents") }
  let destroy!: () => void, flushes = 0
  const sender = { id: phase === "committed" ? 801 : 802, isDestroyed: () => false, once: (_name: string, callback: () => void) => { destroy = callback },
    send: (_name: string, id: string) => { flushes++; void business.desktopBusinessDataService.recordDesktopScan({}, host).then(() => windows.acknowledgeBusinessDataFlush(sender.id, id, true)) } }
  windows.trackBusinessDataWindow(sender as never); windows.markBusinessDataWindowReady(sender.id)
  const settings = await import("../data-root-settings-service")
  settings.setDataRootMaintenanceMode()
  script.result = { phase, journalPath: join(homeDir, "owned-journal.json"), writersReleased: phase === "committed", startup: phase === "committed" ? "ready" : "not-started", recoveryWritersReleased: phase !== "committed" }
  script.launches.length = 0
  vi.useFakeTimers()
  try {
    const result = await settings.migrateDesktopDataRoot(target)
    expect(result.usableRoot).toBe(phase === "committed" ? target : root)
    expect(settings.isDataRootMigrationShutdown()).toBe(true)
    await vi.runAllTimersAsync()
    expect(script.launches).toEqual([{ args: ["owned-desktop-entry", "--data-root", result.usableRoot], config: undefined }])
    expect(flushes).toBe(1)
    await expect(gate.desktopOperationGate.run("business-data:write", async () => {})).rejects.toThrow(/迁移/)
  } finally { destroy(); process.env.VYKOR_CONFIG_DIR = root }
})

it("keeps an unsaved draft, reopens only the recovered unsealed source, then permits a successful retry", async () => {
  vi.resetModules()
  const paths = await import("@vykor/host-config/paths"), root = process.env.VYKOR_CONFIG_DIR!, homeDir = process.env.USERPROFILE!
  await paths.initializeDataRoot({ homeDir, explicitRoot: root, env: { HOME: homeDir, USERPROFILE: homeDir } })
  const gate = await import("../../../core/ipc/operation-gate"), windows = await import("../../business-data/window-flush")
  const business = await import("../../business-data/business-data-service"), settings = await import("../data-root-settings-service")
  gate.setDesktopRootWriter(await paths.acquireDataRootWriter({ homeDir, dataRoot: root, kind: "desktop" }))
  settings.setDataRootMaintenanceMode()
  let fail = true, resumed = false, destroy!: () => void
  const draft = { text: "owned unsaved draft" }
  const sender = { id: 803, isDestroyed: () => false, once: (_event: string, callback: () => void) => { destroy = callback },
    send: (event: string, id: string) => {
      if (event === "business-data:export-resumed") { resumed = true; return }
      if (fail) { windows.acknowledgeBusinessDataFlush(sender.id, id, false); return }
      void business.desktopBusinessDataService.recordDesktopScan({}, { userDataDir: join(homeDir, "userData"), documentsDir: join(homeDir, "documents") }).then(() => windows.acknowledgeBusinessDataFlush(sender.id, id, true))
    } }
  windows.trackBusinessDataWindow(sender as never); windows.markBusinessDataWindowReady(sender.id)
  script.recoverAfterFailedExport = true
  script.launches.length = 0
  try {
    const result = await settings.migrateDesktopDataRoot(join(homeDir, "retry-target"))
    expect(result).toMatchObject({ phase: "failed", usableRoot: root })
    expect(resumed).toBe(true)
    expect(draft.text).toBe("owned unsaved draft")
    expect(settings.isDataRootMigrationShutdown()).toBe(false)
    expect(script.launches).toEqual([])
    await expect(gate.desktopOperationGate.run("business-data:write", async () => draft.text)).resolves.toBe("owned unsaved draft")
    fail = false; script.result = { phase: "committed", writersReleased: true, startup: "ready" }
    vi.useFakeTimers()
    expect(await settings.migrateDesktopDataRoot(join(homeDir, "retry-target"))).toMatchObject({ phase: "committed" })
    expect(settings.isDataRootMigrationShutdown()).toBe(true)
    await vi.runAllTimersAsync()
    expect(script.launches).toHaveLength(1)
    await expect(gate.desktopOperationGate.run("business-data:write", async () => {})).rejects.toThrow(/迁移/)
  } finally { destroy(); script.recoverAfterFailedExport = false; process.env.VYKOR_CONFIG_DIR = root }
})

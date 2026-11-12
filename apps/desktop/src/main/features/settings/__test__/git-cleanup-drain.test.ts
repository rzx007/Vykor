import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { acquireDataRootWriter, listDataRootWriters } from "@vykor/host-config/paths"
import { defaultGitPreferences, GitSettingsChannels } from "../../../../shared/git-settings-types"

const state = vi.hoisted(() => ({
  events: [] as string[], records: [] as any[], preferences: {} as any, scanned: false,
  remove: undefined as (() => void) | undefined, entered: undefined as (() => void) | undefined,
}))
vi.mock("electron", () => ({ dialog: {} }))
vi.mock("@vykor/server", () => ({ createDesktopGitWorktree: vi.fn() }))
vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>()
  const { promisify } = await import("node:util")
  const execute = promisify(actual.execFile)
  const execFile = Object.assign((...args: Parameters<typeof actual.execFile>) => actual.execFile(...args), {
    [promisify.custom]: async (command: string, args: string[], options: unknown) => {
      if (command !== "git") return execute(command, args, options as never)
      expect(args.slice(0, 2)).toEqual(["worktree", "remove"])
      state.events.push("git-start")
      await new Promise<void>(resolve => { state.remove = resolve; state.entered?.() })
      state.events.push("git-finish")
      return { stdout: "", stderr: "" }
    },
  })
  return { ...actual, execFile }
})
vi.mock("../git-settings-storage", () => ({
  getGitPreferences: () => state.preferences,
  saveGitPreferences: (preferences: unknown) => state.preferences = preferences,
  getGitSettings: () => ({ worktrees: state.records }),
  updateGitWorktrees: (update: (records: any[]) => any[]) => { state.records = update(state.records); state.events.push("records-write") },
}))
vi.mock("../../session/session-service", () => ({ desktopSessionService: {
  daemonClient: async () => { state.events.push("client"); return {} },
} }))
vi.mock("../runtime-settings-service", () => ({ desktopRuntimeSettingsService: {} }))
vi.mock("../../business-data/business-data-service", () => ({ desktopBusinessDataService: {
  flush: async () => { state.scanned = true; state.events.push("flush") },
} }))
vi.mock("../../business-data/legacy-import", () => ({ readLegacyImportManifest: () => ({
  sources: {}, desktopScan: { id: state.scanned ? "fresh" : "old", sources: {}, userDataDir: "owned", documentsDir: "owned" },
}) }))

let home: string | undefined
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); if (home) await rm(home, { recursive: true, force: true }) })

it("drains the preferences autoCleanup Git write before releasing the Desktop writer", async () => {
  home = await mkdtemp(join(tmpdir(), "desktop-cleanup-drain-"))
  const root = join(home, "root"), worktree = join(root, "worktree")
  await mkdir(worktree, { recursive: true }); vi.stubEnv("VYKOR_CONFIG_DIR", root)
  state.preferences = defaultGitPreferences; state.events = []; state.scanned = false
  state.records = [{ id: "owned", path: worktree, projectPath: home, environment: "native" }]
  const { gitSettingsService } = await import("../git-settings-service")
  vi.spyOn(gitSettingsService, "worktrees").mockResolvedValue([{ ...state.records[0], cleanupAllowed: true }] as never)
  const { gitSettingsIpcContribution } = await import("../git-settings-ipc")
  const { desktopOperationGate, setDesktopRootWriter } = await import("../../../core/ipc/operation-gate")
  const { prepareDesktopRootMigration } = await import("../../business-data/window-flush")
  const lease = await acquireDataRootWriter({ homeDir: home, dataRoot: root, kind: "desktop" })
  setDesktopRootWriter({ async release() { state.events.push("release"); await lease.release() } })
  const entered = new Promise<void>(resolve => { state.entered = resolve })
  const handler = gitSettingsIpcContribution.register({} as never).find(entry => entry.channel === GitSettingsChannels.preferences)!.handler
  const updating = desktopOperationGate.run(GitSettingsChannels.preferences, () => handler({} as never, {
    preferences: { ...defaultGitPreferences, autoCleanup: true }, expected: defaultGitPreferences,
  }))
  await entered
  let ready = false
  const migrating = prepareDesktopRootMigration(async () => { state.events.push("pause") }).then(() => { ready = true })
  try {
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(ready).toBe(false)
    expect(await listDataRootWriters(root)).toMatchObject([{ kind: "desktop", pid: process.pid }])
    expect(state.events).toEqual(["client", "git-start"])
  } finally { state.remove!(); await updating; await migrating }
  expect(state.records).toEqual([])
  expect(state.events).toEqual(["client", "git-start", "git-finish", "records-write", "records-write", "flush", "pause", "release"])
  expect(await listDataRootWriters(root)).toEqual([])
}, 20000)

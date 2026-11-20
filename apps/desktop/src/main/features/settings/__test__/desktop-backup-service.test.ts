import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import type { MaintenanceBackupResult } from "../../../../shared/maintenance-settings-types"
import { DesktopBackupService } from "../desktop-backup-service"

const temporaryDirectories: string[] = []
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function fixture(version: 1 | 2 | 3 | 4 = 4) {
  const directory = await mkdtemp(join(tmpdir(), "desktop-combined-backup-"))
  temporaryDirectories.push(directory)
  const liveRoot = join(directory, "live")
  await mkdir(liveRoot)
  const result = (path: string): MaintenanceBackupResult => ({
    path,
    manifest: {
      version, backupId: "fixture-backup", createdAt: 1, database: "database.sqlite",
      directories: { artifacts: false, memory: false, "execution-output": false, attachments: false, ...(version === 3 ? { notes: true } : {}) },
      ...(version === 4 ? { scope: "daemon-only" } : {}),
      recovery: { reviveLiveProcesses: false, closeActiveRecordsOnStartup: true },
    } as MaintenanceBackupResult["manifest"],
    totalBytes: 7,
  })
  const createDaemon = vi.fn(async ({ destination }: { destination: string; recordAudit: false }) => {
    await mkdir(destination)
    await writeFile(join(destination, "checksums.json"), "{}")
    return result(destination)
  })
  const verifyDaemon = vi.fn(async (source: string) => result(source))
  const restoreDaemon = vi.fn(async (_source: string, target: string) => {
    await mkdir(join(target, "memory"), { recursive: true })
    await writeFile(join(target, "memory", "file"), "memory data")
    await writeFile(join(target, "sessions.db"), "old backend records")
    return { ...result(target), settingsSnapshotPath: join(target, "settings.snapshot.json") }
  })
  const flushDesktop = vi.fn(async () => {})
  const validateNotes = vi.fn(async (notes: string) => { await readFile(join(notes, "notes.sqlite")) })
  const backupNotes = vi.fn(async (destination: string) => {
    await mkdir(destination)
    await writeFile(join(destination, "notes.sqlite"), "notes index")
    await writeFile(join(destination, "note.md"), "after the latest Desktop save")
  })
  const importNotes = vi.fn(async ({ databasePath, destination }: { databasePath: string; notesDirectory: string; destination: string }) => {
    expect(await readFile(databasePath, "utf8")).toBe("old backend records")
    await mkdir(destination, { recursive: true })
    await writeFile(join(destination, "notes.sqlite"), "imported notes index")
  })
  const recordBackup = vi.fn(async () => {})
  const service = new DesktopBackupService({
    liveRoot: () => liveRoot, createDaemon, verifyDaemon, restoreDaemon,
    flushDesktop, validateNotes, backupNotes, importNotes, recordBackup,
  })
  return { directory, liveRoot, service, createDaemon, verifyDaemon, restoreDaemon, flushDesktop, validateNotes, backupNotes, importNotes, recordBackup }
}

it("publishes only after both snapshots verify and restores the local note index with the daemon snapshot", async () => {
  const f = await fixture()
  const destination = join(f.directory, "backup")
  await mkdir(destination)
  const options = { destination, includeMemory: false, includeOutput: true }
  expect(await f.service.backup(options)).toMatchObject({ path: destination, desktopNotes: true })
  expect(f.flushDesktop).toHaveBeenCalledBefore(f.backupNotes)
  expect(f.createDaemon).toHaveBeenCalledWith({ ...options, destination: expect.any(String), recordAudit: false })
  expect(f.recordBackup).toHaveBeenCalledWith(expect.objectContaining({ path: destination, desktopNotes: true }))
  expect((await readdir(destination)).sort()).toEqual(["daemon", "desktop-backup.json", "notes"])
  await expect(f.service.verify(destination)).resolves.toMatchObject({ path: destination, desktopNotes: true })

  const target = join(f.directory, "restored")
  const restored = await f.service.restore({ source: destination, target })
  expect(restored).toMatchObject({ path: target, desktopNotes: true, settingsSnapshotPath: join(target, "data", "session-runtime", "settings.snapshot.json") })
  expect(await readFile(join(target, "data", "desktop", "notes", "note.md"), "utf8")).toBe("after the latest Desktop save")
  expect(await readFile(join(target, "data", "session-runtime", "sessions.db"), "utf8")).toBe("old backend records")
  expect(await readFile(join(target, "data", "memory", "file"), "utf8")).toBe("memory data")
  expect(f.importNotes).not.toHaveBeenCalled()
})

it("keeps the chosen target empty after a snapshot failure and refuses a corrupt component on verify or restore", async () => {
  const f = await fixture()
  const destination = join(f.directory, "backup")
  await mkdir(destination)
  const options = { destination, includeMemory: false, includeOutput: false }
  f.validateNotes.mockRejectedValueOnce(new Error("notes failed validation"))
  await expect(f.service.backup(options)).rejects.toThrow("notes failed validation")
  expect(await readdir(destination)).toEqual([])
  expect((await readdir(f.directory)).sort()).toEqual(["backup", "live"])
  expect(f.recordBackup).not.toHaveBeenCalled()

  await f.service.backup(options)
  await writeFile(join(destination, "notes", "note.md"), "edited after backup")
  await expect(f.service.verify(destination)).rejects.toThrow(/校验/)
  const target = join(f.directory, "restored")
  await expect(f.service.restore({ source: destination, target })).rejects.toThrow(/校验/)
  expect(f.restoreDaemon).not.toHaveBeenCalled()
  expect(await readdir(f.directory)).not.toContain("restored")
})

it("returns the published backup even if its history entry could not be recorded", async () => {
  const f = await fixture()
  const destination = join(f.directory, "backup")
  f.recordBackup.mockRejectedValueOnce(new Error("history directory became read-only"))
  await expect(f.service.backup({ destination, includeMemory: false, includeOutput: false })).resolves.toMatchObject({
    path: destination, historyRecorded: false,
  })
  await expect(f.service.verify(destination)).resolves.toMatchObject({ path: destination, desktopNotes: true })
})

it("rejects a replacement daemon snapshot with the same ID before publishing a recovery", async () => {
  const f = await fixture()
  const source = join(f.directory, "backup")
  await f.service.backup({ destination: source, includeMemory: false, includeOutput: false })
  const restore = f.restoreDaemon.getMockImplementation()!
  f.restoreDaemon.mockImplementationOnce(async (daemon, target) => {
    const result = await restore(daemon, target)
    await writeFile(join(daemon, "checksums.json"), '{"changed":true}')
    return result
  })
  await expect(f.service.restore({ source, target: join(f.directory, "restored") })).rejects.toThrow(/校验/)
  expect(await readdir(f.directory)).not.toContain("restored")
})

it.each([1, 2, 3] as const)("converts v%s into Desktop notes without modifying the original archive", async (version) => {
  const f = await fixture(version)
  const source = join(f.directory, "old")
  await mkdir(source)
  await writeFile(join(source, "database.sqlite"), "original backup")
  const target = join(f.directory, "restored")
  await expect(f.service.restore({ source, target })).resolves.toMatchObject({ path: target, desktopNotes: true })
  expect(f.importNotes).toHaveBeenCalledWith({ databasePath: expect.stringMatching(/sessions\.db$/), notesDirectory: expect.stringMatching(/notes$/), destination: expect.stringMatching(/notes$/) })
  expect(await readFile(join(target, "data", "desktop", "notes", "notes.sqlite"), "utf8")).toBe("imported notes index")
  expect(await readFile(join(source, "database.sqlite"), "utf8")).toBe("original backup")
})

it("refuses a nested or occupied destination without changing its files", async () => {
  const f = await fixture()
  await expect(f.service.backup({ destination: join(f.liveRoot, "backup"), includeMemory: false, includeOutput: false })).rejects.toThrow(/分离/)
  const target = join(f.directory, "occupied")
  await mkdir(target)
  await writeFile(join(target, "keep"), "original")
  await expect(f.service.restore({ source: f.liveRoot, target })).rejects.toThrow(/分离/)
  await expect(f.service.backup({ destination: target, includeMemory: false, includeOutput: false })).rejects.toThrow(/空目录/)
  expect(await readFile(join(target, "keep"), "utf8")).toBe("original")
  expect(f.createDaemon).not.toHaveBeenCalled()
})

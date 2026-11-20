import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const noteFiles = vi.hoisted(() => ({ hasDesktopNotesImportReceipt: vi.fn(), importLegacyNotes: vi.fn() }))
const host = vi.hoisted(() => ({
  readDaemonRegistry: vi.fn(),
  readRegisteredDataLocation: vi.fn(),
  readLegacyDataLocation: vi.fn(),
  requestDaemon: vi.fn(),
  stopRegisteredDaemon: vi.fn(),
  daemonPidAlive: vi.fn(),
  withDaemonControlLock: vi.fn(),
  acquireRegistryLease: vi.fn(),
}))
vi.mock("@vykor/services/notes", () => noteFiles)
vi.mock("@vykor/server/daemon-host", async (load) => ({ ...await load<typeof import("@vykor/server/daemon-host")>(), ...host }))

import { prepareLegacyNoteImport } from "../legacy-note-import"

let homeDirectory: string
beforeEach(async () => {
  vi.resetAllMocks()
  homeDirectory = await mkdtemp(join(tmpdir(), "vykor-legacy-notes-test-"))
  host.withDaemonControlLock.mockImplementation(async (run) => run(new AbortController().signal))
  host.acquireRegistryLease.mockResolvedValue(async () => {})
  host.daemonPidAlive.mockReturnValue(true)
})
afterEach(async () => { if (homeDirectory) await rm(homeDirectory, { recursive: true, force: true }) })

async function fixture() {
  const dataRoot = join(homeDirectory, "selected")
  const dataDirectory = join(dataRoot, "data")
  const destination = join(dataDirectory, "desktop", "notes")
  const legacyDataLocationPath = join(homeDirectory, "profile", "runtime-data-location.json")
  const registryPath = join(dataDirectory, "daemon", "registry.json")
  const storePath = join(dataDirectory, "session-runtime", "sessions.db")
  await mkdir(dirname(registryPath), { recursive: true })
  await writeFile(registryPath, "{}")
  const registry = { url: "http://127.0.0.1:12345", pid: 12345, token: "token", startedAt: 1, version: "1.0.0", storePath }
  host.readDaemonRegistry.mockImplementation((file) => file === registryPath ? registry : undefined)
  host.requestDaemon.mockImplementation(async (_endpoint, path) =>
    Response.json(path === "/debug/process" ? { pid: registry.pid } : { prepared: true }),
  )
  host.stopRegisteredDaemon.mockImplementation(async (verify) => {
    expect(await verify(registry)).toBe(true)
    host.daemonPidAlive.mockReturnValue(false)
  })
  return { input: { dataRoot, dataDirectory, homeDirectory, destination, legacyDataLocationPath }, registry, registryPath }
}

describe("legacy desktop Notes upgrade", () => {
  it("opens an already published target without re-discovering or stopping the old daemon", async () => {
    const { input } = await fixture()
    noteFiles.hasDesktopNotesImportReceipt.mockReturnValue(true)
    await prepareLegacyNoteImport(input)
    expect(host.readDaemonRegistry).not.toHaveBeenCalled()
    expect(host.stopRegisteredDaemon).not.toHaveBeenCalled()
    expect(noteFiles.importLegacyNotes).not.toHaveBeenCalled()
  })

  it("verifies and drains the old daemon before reading under both registry leases", async () => {
    const { input, registry, registryPath } = await fixture()
    const releaseOwner = vi.fn(async () => {})
    let holdingControl = false
    host.withDaemonControlLock.mockImplementation(async (run) => {
      holdingControl = true
      try { return await run(new AbortController().signal) }
      finally { holdingControl = false }
    })
    host.acquireRegistryLease.mockResolvedValue(releaseOwner)
    noteFiles.importLegacyNotes.mockImplementation(async () => {
      expect(holdingControl).toBe(true)
      expect(host.stopRegisteredDaemon).toHaveBeenCalledOnce()
      expect(host.acquireRegistryLease).toHaveBeenCalledWith(registryPath, "owner", expect.any(Function))
      expect(releaseOwner).not.toHaveBeenCalled()
    })

    await prepareLegacyNoteImport(input)
    expect(host.requestDaemon.mock.calls.map(([, path]) => path)).toEqual([
      "/debug/process", "/maintenance/prepare-root-migration", "/debug/process",
    ])
    expect(noteFiles.importLegacyNotes).toHaveBeenCalledExactlyOnceWith({
      databasePath: registry.storePath, destination: input.destination,
    }, { signal: expect.any(AbortSignal) })
    expect(releaseOwner).toHaveBeenCalledOnce()
  })

  it("leaves a busy old daemon and unpublished destination alone", async () => {
    const { input, registry } = await fixture()
    host.requestDaemon.mockImplementation(async (_endpoint, path) =>
      path === "/debug/process" ? Response.json({ pid: registry.pid }) : Response.json({}, { status: 409 }),
    )
    await expect(prepareLegacyNoteImport(input)).rejects.toThrow(/未结束的工作/)
    expect(host.stopRegisteredDaemon).not.toHaveBeenCalled()
    expect(noteFiles.importLegacyNotes).not.toHaveBeenCalled()
  })

  it("keeps the daemon available when desktop recovery drafts cannot flush", async () => {
    const { input } = await fixture()
    const flushRecovery = vi.fn(async () => { throw new Error("draft write failed") })
    await expect(prepareLegacyNoteImport({ ...input, flushRecovery })).rejects.toThrow("draft write failed")
    expect(host.requestDaemon).not.toHaveBeenCalled()
    expect(host.stopRegisteredDaemon).not.toHaveBeenCalled()
    expect(noteFiles.importLegacyNotes).not.toHaveBeenCalled()
  })

  it("rejects a replaced registration without stopping or opening either database", async () => {
    const { input, registry } = await fixture()
    host.requestDaemon.mockImplementation(async (_endpoint, path) => {
      if (path === "/debug/process") return Response.json({ pid: registry.pid })
      host.readDaemonRegistry.mockReturnValue({ ...registry, token: "replacement", startedAt: 2 })
      return Response.json({ prepared: true })
    })
    await expect(prepareLegacyNoteImport(input)).rejects.toThrow(/发生变化/)
    expect(host.stopRegisteredDaemon).not.toHaveBeenCalled()
    expect(noteFiles.importLegacyNotes).not.toHaveBeenCalled()
  })

  it("requires explicit resolution if the recorded legacy root still has a live daemon", async () => {
    const { input, registry, registryPath } = await fixture()
    const otherDirectory = join(homeDirectory, "other-root", "data")
    const otherFile = join(otherDirectory, "daemon", "registry.json")
    const alternate = { ...registry, pid: 54321, storePath: join(otherDirectory, "session-runtime", "sessions.db") }
    await mkdir(dirname(otherFile), { recursive: true })
    await writeFile(otherFile, "{}")
    host.readRegisteredDataLocation.mockResolvedValue({ directory: input.dataDirectory, storePath: registry.storePath })
    host.readLegacyDataLocation.mockResolvedValue({ directory: otherDirectory, storePath: alternate.storePath })
    host.readDaemonRegistry.mockImplementation((path) => path === registryPath ? registry : alternate)

    await expect(prepareLegacyNoteImport(input)).rejects.toThrow(/另一个数据目录的后台仍在运行/)
    expect(host.stopRegisteredDaemon).not.toHaveBeenCalled()
    expect(noteFiles.importLegacyNotes).not.toHaveBeenCalled()
  })
})

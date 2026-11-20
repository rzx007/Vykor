import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { noteFilePath, openDesktopNoteRepository } from "@vykor/services/notes"
import { beforeEach, describe, expect, it, vi } from "vitest"

const remote = vi.hoisted(() => vi.fn(async () => { throw new Error("Unexpected daemon use") }))
vi.mock("../../session/session-service", () => ({ desktopSessionService: { daemonTransport: remote } }))

import { DesktopNoteService } from "../note-service"

function fixture() {
  const directory = join(process.cwd(), "test-notes")
  const note = { id: "n1", content: "first", revision: 1, createdAt: 1, updatedAt: 1 }
  const repository = {
    list: vi.fn(() => [note]),
    create: vi.fn(() => note),
    update: vi.fn(() => note),
    remove: vi.fn(() => true),
    organization: vi.fn(),
    saveOrganization: vi.fn(),
  }
  const close = vi.fn()
  const backupTo = vi.fn(async (_: string) => {})
  const open = vi.fn(async (_: string) => ({ repository, close, backupTo }))
  const openPath = vi.fn(async (_: string) => "")
  const service = new DesktopNoteService({ directory: () => directory, open, openPath })
  return { directory, note, repository, close, backupTo, open, openPath, service }
}

beforeEach(() => { remote.mockClear() })

describe("desktop-local notes", () => {
  it("opens the local folder and serves all queued reads without contacting a daemon", async () => {
    const { directory, note, open, openPath, service } = fixture()
    await expect(service.create({ content: "first" })).resolves.toEqual(note)
    await expect(service.list()).resolves.toEqual([note])
    await expect(service.openDirectory()).resolves.toBeUndefined()
    expect(open).toHaveBeenCalledExactlyOnceWith(directory)
    expect(openPath).toHaveBeenCalledExactlyOnceWith(directory)
    expect(remote).not.toHaveBeenCalled()
  })

  it("rejects invalid inputs before opening or changing storage", async () => {
    const { open, service } = fixture()
    await expect(service.create({ content: "x", path: "other.md" })).rejects.toMatchObject({ status: 400 })
    await expect(service.update("../other", { content: "x", expectedRevision: 1 })).rejects.toMatchObject({ status: 400 })
    await expect(service.remove(123)).rejects.toMatchObject({ status: 400 })
    await expect(service.saveOrganization(null)).rejects.toMatchObject({ status: 400 })
    expect(open).not.toHaveBeenCalled()
  })

  it("retries a failed initial import without dropping a later valid operation", async () => {
    const { note, open, service } = fixture()
    open.mockRejectedValueOnce(new Error("isolated import failure"))
    await expect(service.list()).rejects.toThrow("isolated import failure")
    await expect(service.create({ content: "first" })).resolves.toEqual(note)
    expect(open).toHaveBeenCalledTimes(2)
  })

  it("keeps writes and shutdown behind the current backup", async () => {
    const { service, backupTo, close, repository } = fixture()
    let release!: () => void
    let reportBackupStarted!: () => void
    const started = new Promise<void>((resolve) => { reportBackupStarted = resolve })
    backupTo.mockImplementationOnce(() => new Promise((resolve) => {
      release = resolve
      reportBackupStarted()
    }))
    const backup = service.backupTo("isolated destination")
    await started
    const write = service.create({ content: "after snapshot" })
    const drained = service.flush()
    const closing = service.close()
    await expect(service.create({ content: "too late" })).rejects.toThrow(/便签已关闭/)
    expect(repository.create).not.toHaveBeenCalled()
    expect(close).not.toHaveBeenCalled()
    release()
    await Promise.all([backup, write, drained, closing])
    expect(repository.create.mock.invocationCallOrder[0]).toBeLessThan(close.mock.invocationCallOrder[0]!)
  })

  it("reads real SQLite+Markdown offline after restart and preserves conflict behavior", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vykor-desktop-local-notes-"))
    const options = {
      directory: () => directory,
      open: async () => openDesktopNoteRepository(directory),
      openPath: vi.fn(async () => ""),
    }
    const first = new DesktopNoteService(options)
    const restored = new DesktopNoteService(options)
    try {
      const initial = await first.create({ content: "saved offline" })
      const edits = { expectedRevision: initial.revision, content: "from first window" }
      const write = first.update(initial.id, edits)
      const conflict = first.update(initial.id, { ...edits, content: "from stale window" })
      await expect(conflict).rejects.toMatchObject({ name: "VykorApiError", status: 409, message: expect.stringContaining("Note revision conflict:") })
      const saved = await write

      await writeFile(noteFilePath(directory, saved.id), "changed outside", "utf8")
      await first.reconcileBeforeMove()
      const [edited] = await first.list()
      expect(edited).toMatchObject({ content: "changed outside", revision: saved.revision + 1 })
      const organization = await first.organization()
      expect(organization.organization.desktop).toContainEqual({ type: "note", id: saved.id })

      const extra = await first.create({ content: "then deleted" })
      await first.remove(extra.id)
      await first.close()
      await expect(restored.list()).resolves.toEqual([edited])
      await expect(restored.remove(extra.id)).rejects.toMatchObject({ status: 404 })

      await writeFile(join(directory, "organization.json"), '{"version":2}', "utf8")
      const readOnly = await restored.organization()
      expect(readOnly.readOnly).toBe(true)
      await expect(restored.saveOrganization({ ...readOnly, readOnly: undefined, warning: undefined })).rejects.toMatchObject({ status: 400 })
      await expect(restored.saveOrganization({ organization: readOnly.organization, expectedEtag: readOnly.etag })).rejects.toMatchObject({ status: 409 })
      expect(remote).not.toHaveBeenCalled()
    } finally {
      await Promise.all([first.close(), restored.close()])
      await rm(directory, { recursive: true, force: true })
    }
  })
})

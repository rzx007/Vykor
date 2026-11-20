import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it, vi } from "vitest"

const paths = vi.hoisted(() => ({ home: "", dataRoot: "", profile: "" }))
vi.mock("electron", () => ({
  app: { getPath: () => paths.profile },
  shell: { openPath: async () => "" },
}))
vi.mock("@vykor/host-config/paths", async (load) => ({
  ...await load<typeof import("@vykor/host-config/paths")>(),
  dataRootHome: () => paths.home,
  getDataRoot: () => paths.dataRoot,
  getDataDir: () => join(paths.dataRoot, "data"),
  getDesktopDataDir: () => join(paths.dataRoot, "data", "desktop"),
  getInitializedDataRootInputs: () => undefined,
}))

import { DesktopNoteService } from "../note-service"

const Database = createRequire(import.meta.url)("better-sqlite3")

it("imports the pinned root through the Desktop service, then opens the published notes offline on restart", async () => {
  paths.home = await mkdtemp(join(tmpdir(), "vykor-desktop-notes-offline-"))
  paths.dataRoot = join(paths.home, "root")
  paths.profile = join(paths.home, "electron-profile")
  const original = join(paths.dataRoot, "data/session-runtime/notes")
  await mkdir(original, { recursive: true })
  const originalFile = join(original, "legacy-note.md")
  const content = "old Markdown"
  await writeFile(originalFile, content, "utf8")
  const databasePath = join(paths.dataRoot, "data/session-runtime/sessions.db")
  const database = new Database(databasePath)
  try {
    database.exec(`CREATE TABLE note_file_index (
      id TEXT PRIMARY KEY, revision INTEGER, created_at REAL, updated_at REAL, sha256 TEXT, deleted_at REAL
    )`)
    database.prepare("INSERT INTO note_file_index VALUES (?, ?, ?, ?, ?, NULL)")
      .run("legacy-note", 4, 1000, 2000, createHash("sha256").update(content).digest("hex"))
  } finally { database.close() }
  const oldBytes = await readFile(databasePath)
  const service = new DesktopNoteService()
  const restarted = new DesktopNoteService()
  try {
    await service.initialize()
    const [imported] = await service.list()
    expect(imported).toMatchObject({ id: "legacy-note", content, revision: 4, createdAt: 1000, updatedAt: 2000 })
    await service.update(imported.id, { content: "edited locally", expectedRevision: imported.revision })
    await service.close()

    await expect(restarted.list()).resolves.toMatchObject([{ id: "legacy-note", content: "edited locally" }])
    expect(await readFile(originalFile, "utf8")).toBe("old Markdown")
    expect(await readFile(databasePath)).toEqual(oldBytes)
    expect(await readFile(join(paths.dataRoot, "data/desktop/notes/legacy-note.md"), "utf8")).toBe("edited locally")
    const nativeFiles = await readdir(join(paths.dataRoot, "data/desktop/notes"), { withFileTypes: true })
    expect(nativeFiles.every(file => file.isFile())).toBe(true)
    expect(nativeFiles.map(file => file.name)).toEqual(expect.arrayContaining(["notes.sqlite", "import-receipt.json", "legacy-note.md"]))
  } finally {
    await Promise.all([service.close(), restarted.close()])
    await rm(paths.home, { recursive: true, force: true })
  }
})

import { mkdtemp, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, expect, it } from "vitest"
import { BusinessDataService } from "../business-data-service"
import { readLegacyImportManifest } from "../legacy-import"
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "desktop-export-")); roots.push(root)
  return { root, service: new BusinessDataService(root), host: { userDataDir: join(root, "electron"), documentsDir: join(root, "OneDrive", "Documents") }, manifest: join(root, "data", "desktop", "legacy-import.json") }
}
it("records an empty profile scan bound to real host locations", async () => {
  const { service, host, manifest } = await setup()
  const receipt = await service.recordDesktopScan({}, host)
  expect(receipt.ready).toBe(true)
  expect(readLegacyImportManifest(manifest).desktopScan).toMatchObject({ version: 1, id: receipt.id, ...host, sources: {} })
})
it("checks source digests, preserves newer business edits and invalidates a known changed source", async () => {
  const { service, host, manifest } = await setup()
  await service.importLegacy({ kind: "notes" }, { version: 1, drafts: [] }, "a".repeat(64))
  await service.recordDesktopScan({ notes: "a".repeat(64) }, host)
  await service.write({ kind: "notes" }, { version: 1, drafts: [{ draftId: "n", noteId: null, baseRevision: null, content: "new edit", updatedAt: 1 }] }, 1)
  expect((await service.recordDesktopScan({ notes: "a".repeat(64) }, host)).ready).toBe(true)
  await expect(service.importLegacy({ kind: "notes" }, { version: 1, drafts: [] }, "b".repeat(64))).rejects.toThrow(/LEGACY_CHANGED/)
  expect(readLegacyImportManifest(manifest).desktopScan).toBeUndefined()
  expect((await service.read({ kind: "notes" }))?.revision).toBe(2)
})
it("records pending partial imports and permits a new ready scan only after matching acknowledgement", async () => {
  const { service, host } = await setup()
  await service.importLegacy({ kind: "composer" }, { version: 1, drafts: {}, submissions: [] }, "a".repeat(64), ["missing"])
  expect((await service.recordDesktopScan({ composer: "a".repeat(64) }, host)).ready).toBe(false)
  await service.acknowledgeUnresolvedComposer("a".repeat(64))
  expect((await service.recordDesktopScan({ composer: "a".repeat(64) }, host)).ready).toBe(true)
})
it("rejects unsupported keys and digest mismatches without writing private source content", async () => {
  const { service, host, manifest } = await setup()
  await service.recordDesktopScan({}, host)
  await expect(service.recordDesktopScan({ "window-preference": "PRIVATE" }, host)).rejects.toThrow(/INVALID_SCAN/)
  await expect(service.recordDesktopScan({ notes: "a".repeat(64) }, host)).rejects.toThrow(/UNCONFIRMED_SOURCE/)
  expect(readLegacyImportManifest(manifest).desktopScan).toBeUndefined()
  expect(await readFile(manifest, "utf8")).not.toContain("PRIVATE")
})
it("invalidates export readiness when a confirmed target file is missing", async () => {
  const { root, service, host, manifest } = await setup()
  await service.importLegacy({ kind: "notes" }, { version: 1, drafts: [] }, "a".repeat(64))
  await service.recordDesktopScan({ notes: "a".repeat(64) }, host)
  await rm(join(root, "data", "desktop", "notes-recovery.json"))
  await expect(service.recordDesktopScan({ notes: "a".repeat(64) }, host)).rejects.toThrow(/TARGET_MISSING/)
  expect(readLegacyImportManifest(manifest).desktopScan).toBeUndefined()
})
it("invalidates an empty receipt when a newly observed supported source is imported", async () => {
  const { service, host, manifest } = await setup()
  await service.recordDesktopScan({}, host)
  await service.importLegacy({ kind: "notes" }, { version: 1, drafts: [] }, "a".repeat(64))
  expect(readLegacyImportManifest(manifest).desktopScan).toBeUndefined()
  await service.recordDesktopScan({}, host) // A later full scan may confirm that the user removed the retained key.
  await service.importLegacy({ kind: "notes" }, { version: 1, drafts: [] }, "a".repeat(64))
  expect(readLegacyImportManifest(manifest).desktopScan).toBeUndefined()
})

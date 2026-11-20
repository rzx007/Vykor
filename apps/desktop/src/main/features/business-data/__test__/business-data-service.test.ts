import { afterEach, expect, it } from "vitest"
import { mkdtemp, readFile, rm, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BusinessDataService } from "../business-data-service"
const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "business-data-"))
  roots.push(root)
  return { root, service: new BusinessDataService(root) }
}
const value = { version: 1, drafts: [] }
it("rejects unknown kinds, extra paths and image traversal before touching disk", async () => {
  const { service } = await setup()
  for (const key of [
    { kind: "../../outside" },
    { kind: "notes", path: "outside" },
    { kind: "image-annotations", imageKey: "../outside" },
  ])
    await expect(service.write(key as never, value, null)).rejects.toThrow(/INVALID_KEY/)
})
it("serializes competing revisions and keeps the first committed value across restart", async () => {
  const { root, service } = await setup()
  const results = await Promise.allSettled([
    service.write({ kind: "notes" }, value, null),
    service.write({ kind: "notes" }, value, null),
  ])
  expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"])
  await expect(service.write({ kind: "notes" }, value, null)).rejects.toThrow(/REVISION_CONFLICT/)
  expect(await new BusinessDataService(root).read({ kind: "notes" })).toEqual({
    version: 1,
    revision: 1,
    value,
  })
})
it("rejects invalid schema without echoing private content", async () => {
  const { service } = await setup()
  await expect(
    service.write({ kind: "notes" }, { version: 1, drafts: [{ content: "PRIVATE BODY" }] }, null)
  ).rejects.toThrow(/INVALID_VALUE/)
  try {
    await service.write({ kind: "composer" }, "PRIVATE BODY", null)
  } catch (error) {
    expect(String(error)).not.toContain("PRIVATE BODY")
  }
})
it("reports replacement failure and flush cannot claim success", async () => {
  const { root, service } = await setup()
  await mkdir(join(root, "data", "desktop", "notes-recovery.json"), { recursive: true })
  await expect(service.write({ kind: "notes" }, value, null)).rejects.toThrow()
  await expect(service.flush()).rejects.toThrow()
})
it("confirms legacy imports, preserves newer target data and detects changed legacy sources", async () => {
  const { root, service } = await setup()
  const digest = "a".repeat(64)
  await service.importLegacy({ kind: "notes" }, value, digest)
  const newer = {
    version: 1,
    drafts: [{ draftId: "n", noteId: null, baseRevision: null, content: "newer", updatedAt: 1 }],
  }
  await service.write({ kind: "notes" }, newer, 1)
  expect((await service.importLegacy({ kind: "notes" }, value, digest)).revision).toBe(2)
  await expect(service.importLegacy({ kind: "notes" }, value, "b".repeat(64))).rejects.toThrow(
    /LEGACY_CHANGED/
  )
  const manifest = await readFile(join(root, "data", "desktop", "legacy-import.json"), "utf8")
  expect(manifest).toContain(digest)
  expect(manifest).not.toContain("newer")
})

it("serializes confirmations across kinds and acknowledges only the matching partial composer source", async () => {
  const { root, service } = await setup()
  const composer = { version: 1, drafts: {}, submissions: [] },
    digest = "c".repeat(64)
  await Promise.all([
    service.importLegacy({ kind: "notes" }, value, "a".repeat(64)),
    service.importLegacy({ kind: "composer" }, composer, digest, ["missing"]),
  ])
  const path = join(root, "data", "desktop", "legacy-import.json")
  let manifest = JSON.parse(await readFile(path, "utf8"))
  expect(Object.keys(manifest.sources).sort()).toEqual(["composer", "notes"])
  expect(manifest.sources.composer).toMatchObject({
    status: "partial",
    unresolvedSessionIds: ["missing"],
    reason: "session-not-found",
  })
  await expect(service.acknowledgeUnresolvedComposer("d".repeat(64))).rejects.toThrow(
    /INVALID_PARTIAL_SOURCE/
  )
  await service.acknowledgeUnresolvedComposer(digest)
  manifest = JSON.parse(await readFile(path, "utf8"))
  expect(manifest.sources.composer.retainedSourceAcknowledged).toBe(true)
  expect((await service.read({ kind: "composer" }))?.revision).toBe(1)
})

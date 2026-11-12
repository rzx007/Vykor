import { afterEach, expect, it, vi } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
const fault = vi.hoisted(() => ({ confirm: true }))
vi.mock("../legacy-import", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../legacy-import")>()
  return {
    ...actual,
    confirmLegacyImport: (...args: Parameters<typeof actual.confirmLegacyImport>) => {
      if (fault.confirm) throw new Error("WRITE_FAILED")
      return actual.confirmLegacyImport(...args)
    },
  }
})
import { BusinessDataService } from "../business-data-service"
let root: string
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true })
})
it("cannot overwrite a newer target after its import confirmation failed", async () => {
  root = await mkdtemp(join(tmpdir(), "import-confirm-"))
  const service = new BusinessDataService(root),
    old = { version: 1, drafts: [] },
    digest = "f".repeat(64)
  await expect(service.importLegacy({ kind: "notes" }, old, digest)).rejects.toThrow(/WRITE_FAILED/)
  expect((await service.read({ kind: "notes" }))?.revision).toBe(1)
  fault.confirm = false
  const newer = {
    version: 1,
    drafts: [{ draftId: "n", noteId: null, baseRevision: null, content: "new", updatedAt: 1 }],
  }
  await service.write({ kind: "notes" }, newer, 1)
  await expect(service.importLegacy({ kind: "notes" }, old, digest)).rejects.toThrow(
    /LEGACY_CONFLICT/
  )
  expect((await service.read({ kind: "notes" }))?.value).toEqual(newer)
})

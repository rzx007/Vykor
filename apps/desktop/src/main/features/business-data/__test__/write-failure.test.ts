import { afterEach, expect, it, vi } from "vitest"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
const fault = vi.hoisted(() => ({ replace: false }))
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>()
  return {
    ...actual,
    rename: (...args: Parameters<typeof actual.rename>) => {
      if (fault.replace) return Promise.reject(new Error("disk full"))
      return actual.rename(...args)
    },
  }
})
import { BusinessDataService } from "../business-data-service"
let root: string
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true })
})
it("keeps the committed file after a replacement error and allows the same revision to retry", async () => {
  root = await mkdtemp(join(tmpdir(), "business-replace-"))
  const service = new BusinessDataService(root)
  const original = { version: 1, drafts: [] }
  const next = {
    version: 1,
    drafts: [{ draftId: "n", noteId: null, baseRevision: null, content: "new", updatedAt: 1 }],
  }
  await service.write({ kind: "notes" }, original, null)
  fault.replace = true
  await expect(service.write({ kind: "notes" }, next, 1)).rejects.toThrow(/WRITE_FAILED/)
  await expect(service.flush()).rejects.toThrow(/WRITE_FAILED/)
  expect(await new BusinessDataService(root).read({ kind: "notes" })).toEqual({
    version: 1,
    revision: 1,
    value: original,
  })
  expect(await readdir(join(root, "data", "desktop"))).toEqual(["notes-recovery.json"])
  fault.replace = false
  expect((await service.write({ kind: "notes" }, next, 1)).revision).toBe(2)
  await service.flush()
})

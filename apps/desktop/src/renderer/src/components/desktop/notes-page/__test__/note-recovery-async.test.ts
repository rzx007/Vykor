// @vitest-environment jsdom
import { expect, it, vi } from "vitest"
import { createNoteRecoveryPort, readRecoveryDrafts } from "../note-recovery"
it("awaits hydration and preserves an older note when another draft is written", async () => {
  let hydrate!: (value: unknown) => void
  const saved: unknown[] = []
  const old = { draftId: "old", noteId: null, baseRevision: null, content: "keep", updatedAt: 1 }
  const next = { ...old, draftId: "new", content: "new" }
  vi.stubGlobal("window", {
    localStorage,
    desktop: {
      businessData: {
        read: () =>
          new Promise((resolve) => {
            hydrate = resolve
          }),
        write: async (_key: unknown, value: unknown) => {
          saved.push(value)
          return { version: 1, revision: 2, value }
        },
      },
    },
  })
  const pending = createNoteRecoveryPort().write(next)
  await Promise.resolve()
  expect(saved).toEqual([])
  expect(hydrate).toBeTypeOf("function")
  hydrate({ version: 1, revision: 1, value: { version: 1, drafts: [old] } })
  await pending
  expect(saved).toEqual([{ version: 1, drafts: [old, next] }])
  expect(await readRecoveryDrafts()).toEqual([old, next])
  vi.unstubAllGlobals()
})

import { businessDataFixture, resetBusinessDataFixture } from "@renderer/lib/__test__/business-data-fixture"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { createNoteRecoveryPort, readRecoveryDrafts } from "../note-recovery"

type RecoveryDraft = {
  draftId: string
  noteId: string | null
  baseRevision: number | null
  content: string
  updatedAt: number
}

function memoryStorage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() {
      return values.size
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => {
      values.delete(key)
    },
    setItem: (key, value) => {
      values.set(key, value)
    },
  }
}

async function recovery() {
  const path = "../note-recovery"
  const module = (await import(/* @vite-ignore */ path).catch(() => null)) as null | {
    NOTE_RECOVERY_STORAGE_KEY: string
    readRecoveryDrafts(storage: Storage): Promise<RecoveryDraft[]>
    writeRecoveryDraft(storage: Storage, draft: RecoveryDraft): void
    removeRecoveryDraft(storage: Storage, draftId: string): void
    readSelectedNoteId(storage: Storage): string | null
    writeSelectedNoteId(storage: Storage, noteId: string | null): void
  }
  expect(module).not.toBeNull()
  return module!
}

describe("note recovery", () => {
  let storage: Storage

  beforeEach(() => {
    storage = memoryStorage()
    resetBusinessDataFixture()
    vi.stubGlobal("window", { desktop: { businessData: businessDataFixture } })
  })

  it("keeps the main and quick-window drafts for the same note independent", async () => {
    const main = createNoteRecoveryPort(storage)
    const quick = createNoteRecoveryPort(storage, "quick")
    const original = {
      draftId: "same-note",
      noteId: "same-note",
      baseRevision: 1,
      content: "main text",
      updatedAt: 1,
    }
    await main.write(original)
    await quick.write({ ...original, content: "quick text" })
    expect((await readRecoveryDrafts(storage))[0]?.content).toBe("main text")
    expect((await readRecoveryDrafts(storage, "quick"))[0]?.content).toBe("quick text")
    await main.remove(original.draftId)
    expect((await readRecoveryDrafts(storage, "quick"))[0]?.content).toBe("quick text")
  })

  it("keeps drafts separately and removes only the confirmed draft", async () => {
    const api = await recovery()
    const draftA: RecoveryDraft = {
      draftId: "a",
      noteId: "n1",
      baseRevision: 1,
      content: "one",
      updatedAt: 1,
    }
    const draftB: RecoveryDraft = {
      draftId: "b",
      noteId: null,
      baseRevision: null,
      content: "two",
      updatedAt: 2,
    }
    await api.writeRecoveryDraft(storage, draftA)
    await api.writeRecoveryDraft(storage, draftB)
    expect(await api.readRecoveryDrafts(storage)).toEqual([draftA, draftB])
    await api.removeRecoveryDraft(storage, "a")
    expect(await api.readRecoveryDrafts(storage)).toEqual([draftB])
  })

  it("reports invalid legacy values without replacing or deleting the source", async () => {
    const api = await recovery()
    storage.setItem(api.NOTE_RECOVERY_STORAGE_KEY, "broken")
    await expect(api.readRecoveryDrafts(storage)).rejects.toThrow(/INVALID_/)
    storage.setItem(
      api.NOTE_RECOVERY_STORAGE_KEY,
      JSON.stringify({ version: 1, drafts: [{ draftId: "", content: 42 }] })
    )
    await expect(api.readRecoveryDrafts(storage)).rejects.toThrow(/INVALID_/)
  })

  it("persists only a nonempty selected note id", async () => {
    const api = await recovery()
    api.writeSelectedNoteId(storage, "n1")
    expect(api.readSelectedNoteId(storage)).toBe("n1")
    api.writeSelectedNoteId(storage, null)
    expect(api.readSelectedNoteId(storage)).toBeNull()
  })
})

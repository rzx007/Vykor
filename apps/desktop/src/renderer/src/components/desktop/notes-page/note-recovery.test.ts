import { beforeEach, describe, expect, it } from "vitest"

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
  const path = "./note-recovery"
  const module = (await import(/* @vite-ignore */ path).catch(() => null)) as null | {
    NOTE_RECOVERY_STORAGE_KEY: string
    readRecoveryDrafts(storage: Storage): RecoveryDraft[]
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
    api.writeRecoveryDraft(storage, draftA)
    api.writeRecoveryDraft(storage, draftB)
    expect(api.readRecoveryDrafts(storage)).toEqual([draftA, draftB])
    api.removeRecoveryDraft(storage, "a")
    expect(api.readRecoveryDrafts(storage)).toEqual([draftB])
  })

  it("repairs malformed or untrusted stored values to an empty collection", async () => {
    const api = await recovery()
    storage.setItem(api.NOTE_RECOVERY_STORAGE_KEY, "broken")
    expect(api.readRecoveryDrafts(storage)).toEqual([])
    storage.setItem(
      api.NOTE_RECOVERY_STORAGE_KEY,
      JSON.stringify({ version: 1, drafts: [{ draftId: "", content: 42 }] })
    )
    expect(api.readRecoveryDrafts(storage)).toEqual([])
  })

  it("persists only a nonempty selected note id", async () => {
    const api = await recovery()
    api.writeSelectedNoteId(storage, "n1")
    expect(api.readSelectedNoteId(storage)).toBe("n1")
    api.writeSelectedNoteId(storage, null)
    expect(api.readSelectedNoteId(storage)).toBeNull()
  })
})

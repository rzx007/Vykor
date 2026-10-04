export const NOTE_RECOVERY_STORAGE_KEY = "vykor.desktop.note-recovery-v1"
export const NOTE_SELECTED_STORAGE_KEY = "vykor.desktop.notes-selected-id-v1"

export interface NoteRecoveryDraft {
  draftId: string
  noteId: string | null
  baseRevision: number | null
  content: string
  updatedAt: number
}

export interface NoteRecoveryPort {
  write(draft: NoteRecoveryDraft): void
  remove(draftId: string): void
}

export function readRecoveryDrafts(storage: Storage = window.localStorage): NoteRecoveryDraft[] {
  try {
    const value: unknown = JSON.parse(storage.getItem(NOTE_RECOVERY_STORAGE_KEY) ?? "null")
    if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.drafts)) return []
    if (!value.drafts.every(isRecoveryDraft)) return []
    return value.drafts
  } catch {
    return []
  }
}

export function writeRecoveryDraft(storage: Storage, draft: NoteRecoveryDraft): void {
  const drafts = new Map(readRecoveryDrafts(storage).map((item) => [item.draftId, item]))
  drafts.set(draft.draftId, draft)
  writeDrafts(storage, [...drafts.values()])
}

export function removeRecoveryDraft(storage: Storage, draftId: string): void {
  const drafts = readRecoveryDrafts(storage).filter((draft) => draft.draftId !== draftId)
  if (drafts.length === 0) {
    try {
      storage.removeItem(NOTE_RECOVERY_STORAGE_KEY)
    } catch {
      // SQLite remains the source of truth when recovery storage is unavailable.
    }
    return
  }
  writeDrafts(storage, drafts)
}

export function createNoteRecoveryPort(storage: Storage = window.localStorage): NoteRecoveryPort {
  return {
    write: (draft) => writeRecoveryDraft(storage, draft),
    remove: (draftId) => removeRecoveryDraft(storage, draftId),
  }
}

export function readSelectedNoteId(storage: Storage = window.localStorage): string | null {
  try {
    return nonemptyString(storage.getItem(NOTE_SELECTED_STORAGE_KEY))
  } catch {
    return null
  }
}

export function writeSelectedNoteId(storage: Storage, noteId: string | null): void {
  try {
    if (noteId) storage.setItem(NOTE_SELECTED_STORAGE_KEY, noteId)
    else storage.removeItem(NOTE_SELECTED_STORAGE_KEY)
  } catch {
    // Selection persistence is optional UI state.
  }
}

function writeDrafts(storage: Storage, drafts: NoteRecoveryDraft[]): void {
  try {
    storage.setItem(NOTE_RECOVERY_STORAGE_KEY, JSON.stringify({ version: 1, drafts }))
  } catch {
    // A failed recovery cache must not stop the durable SQLite save attempt.
  }
}

function isRecoveryDraft(value: unknown): value is NoteRecoveryDraft {
  if (!isRecord(value)) return false
  const noteId = value.noteId
  const revision = value.baseRevision
  return (
    nonemptyString(value.draftId) !== null &&
    (noteId === null || nonemptyString(noteId) !== null) &&
    (revision === null || (Number.isSafeInteger(revision) && Number(revision) >= 1)) &&
    typeof value.content === "string" &&
    typeof value.updatedAt === "number" &&
    Number.isFinite(value.updatedAt)
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function nonemptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null
}

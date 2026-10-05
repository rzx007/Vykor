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

function recoveryKey(scope: "main" | "quick"): string {
  return scope === "main" ? NOTE_RECOVERY_STORAGE_KEY : `${NOTE_RECOVERY_STORAGE_KEY}:quick`
}

export function readRecoveryDrafts(
  storage: Storage = window.localStorage,
  scope: "main" | "quick" = "main"
): NoteRecoveryDraft[] {
  try {
    const value: unknown = JSON.parse(storage.getItem(recoveryKey(scope)) ?? "null")
    if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.drafts)) return []
    if (!value.drafts.every(isRecoveryDraft)) return []
    return value.drafts
  } catch {
    return []
  }
}

export function writeRecoveryDraft(
  storage: Storage,
  draft: NoteRecoveryDraft,
  scope: "main" | "quick" = "main"
): void {
  const drafts = new Map(readRecoveryDrafts(storage, scope).map((item) => [item.draftId, item]))
  drafts.set(draft.draftId, draft)
  writeDrafts(storage, [...drafts.values()], scope)
}

export function removeRecoveryDraft(
  storage: Storage,
  draftId: string,
  scope: "main" | "quick" = "main"
): void {
  const drafts = readRecoveryDrafts(storage, scope).filter((draft) => draft.draftId !== draftId)
  if (drafts.length === 0) {
    try {
      storage.removeItem(recoveryKey(scope))
    } catch {
      // Saved Markdown files remain available when recovery storage is unavailable.
    }
    return
  }
  writeDrafts(storage, drafts, scope)
}

export function createNoteRecoveryPort(
  storage: Storage = window.localStorage,
  scope: "main" | "quick" = "main"
): NoteRecoveryPort {
  return {
    write: (draft) => writeRecoveryDraft(storage, draft, scope),
    remove: (draftId) => removeRecoveryDraft(storage, draftId, scope),
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

function writeDrafts(storage: Storage, drafts: NoteRecoveryDraft[], scope: "main" | "quick"): void {
  try {
    storage.setItem(recoveryKey(scope), JSON.stringify({ version: 1, drafts }))
  } catch {
    // A failed recovery cache must not stop the Markdown file save attempt.
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

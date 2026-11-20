import { recoveryRecord, trackBusinessDataTask } from "@renderer/lib/business-data"
import { noteRecoverySchema } from "@shared/business-data-schema"
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
  write(draft: NoteRecoveryDraft): Promise<void> | void
  remove(draftId: string): Promise<void> | void
}
function record(scope: "main" | "quick") {
  return recoveryRecord({ kind: scope === "main" ? "notes" : "quick-notes" })
}
export async function readRecoveryDrafts(
  storage: Storage = window.localStorage,
  scope: "main" | "quick" = "main"
): Promise<NoteRecoveryDraft[]> {
  const target = record(scope)
  const raw = storage.getItem(
    scope === "main" ? NOTE_RECOVERY_STORAGE_KEY : `${NOTE_RECOVERY_STORAGE_KEY}:quick`
  )
  if (raw) {
    let value: unknown
    try {
      value = JSON.parse(raw)
    } catch {
      throw new Error("business-data notes import INVALID_JSON")
    }
    await target.importLegacy(raw, value)
  }
  const saved = await target.read()
  if (!saved) return []
  const parsed = noteRecoverySchema.safeParse(saved.value)
  if (!parsed.success) throw new Error("business-data notes read INVALID_VALUE")
  return parsed.data.drafts
}
export function writeRecoveryDraft(
  storage: Storage,
  draft: NoteRecoveryDraft,
  scope: "main" | "quick" = "main"
): Promise<void> {
  return trackBusinessDataTask(
    `notes:${scope}`,
    (async () => {
      await readRecoveryDrafts(storage, scope)
      await record(scope).update((value) => {
        const drafts = new Map(
          noteRecoverySchema
            .parse(value ?? { version: 1, drafts: [] })
            .drafts.map((item) => [item.draftId, item])
        )
        drafts.set(draft.draftId, draft)
        return { version: 1, drafts: [...drafts.values()] }
      })
    })()
  )
}
export function removeRecoveryDraft(
  storage: Storage,
  draftId: string,
  scope: "main" | "quick" = "main"
): Promise<void> {
  return trackBusinessDataTask(
    `notes:${scope}`,
    (async () => {
      await readRecoveryDrafts(storage, scope)
      await record(scope).update((value) => ({
        version: 1,
        drafts: noteRecoverySchema
          .parse(value ?? { version: 1, drafts: [] })
          .drafts.filter((draft) => draft.draftId !== draftId),
      }))
    })()
  )
}
export function createNoteRecoveryPort(
  storage: Storage = window.localStorage,
  scope: "main" | "quick" = "main"
): NoteRecoveryPort {
  return {
    write: (draft) => writeRecoveryDraft(storage, draft, scope),
    remove: (id) => removeRecoveryDraft(storage, id, scope),
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

function nonemptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null
}

import type { DesktopItem, NoteOrganizationV1Record } from "@vykor/application-client"
import type { NoteView } from "./note-model"

export function projectNoteDesktop(
  organization: NoteOrganizationV1Record,
  notes: readonly NoteView[]
) {
  const byId = new Map(notes.filter((note) => note.noteId).map((note) => [note.noteId!, note]))
  const pinned: DesktopItem[] = []
  const desktop: DesktopItem[] = []
  for (const item of organization.desktop) {
    if (item.type === "note" && !byId.has(item.id)) continue
    if (item.type === "note" && byId.get(item.id)?.pinned) pinned.push(item)
    else desktop.push(item)
  }
  const drafts = notes.filter((note) => !note.noteId && note.content.trim())
  return { pinned, desktop, drafts, byId }
}

export function searchNoteOrganization(
  organization: NoteOrganizationV1Record,
  notes: readonly NoteView[],
  query: string
) {
  const needle = query.trim().toLocaleLowerCase()
  const matches = (text: string): boolean => text.toLocaleLowerCase().includes(needle)
  const membership = new Map<string, string>()
  for (const [folderId, ids] of Object.entries(organization.folderItems)) {
    for (const id of ids) membership.set(id, folderId)
  }
  return {
    notes: notes
      .filter((note) => (note.noteId || note.content.trim()) && matches(note.content))
      .map((note) => {
        const folderId = note.noteId ? membership.get(note.noteId) : undefined
        return {
          note,
          folderId,
          folderName: folderId ? organization.folders[folderId]?.name : undefined,
        }
      }),
    folders: organization.desktop.filter(
      (item) => item.type === "folder" && matches(organization.folders[item.id]?.name ?? "")
    ),
  }
}

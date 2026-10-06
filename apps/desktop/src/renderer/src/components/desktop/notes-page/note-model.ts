import type { DesktopNote } from "@shared/note-types"
import type { NoteColor } from "./note-appearance"

export interface NoteView {
  draftId: string
  noteId: string | null
  content: string
  revision: number | null
  createdAt: number
  updatedAt: number
  recovered: boolean
  pinned?: boolean
  color?: NoteColor
}

export function noteViewFromRecord(note: DesktopNote): NoteView {
  return {
    draftId: note.id,
    noteId: note.id,
    content: note.content,
    revision: note.revision,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    recovered: false,
  }
}

export function describeNote(content: string): { title: string; preview: string } {
  const lines = content
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
  if (lines.length === 0) return { title: "无标题便签", preview: "" }
  return {
    title: lines[0]!.slice(0, 80),
    preview: lines.slice(1).join(" ").replace(/\s+/gu, " ").slice(0, 120),
  }
}

export function filterAndSortNotes<
  T extends { content: string; createdAt: number; updatedAt: number; pinned?: boolean },
>(notes: readonly T[], query: string): T[] {
  const normalized = query.trim().toLocaleLowerCase()
  return notes
    .filter((note) => !normalized || note.content.toLocaleLowerCase().includes(normalized))
    .slice()
    .sort(
      (left, right) =>
        Number(Boolean(right.pinned)) - Number(Boolean(left.pinned)) ||
        right.updatedAt - left.updatedAt ||
        right.createdAt - left.createdAt
    )
}

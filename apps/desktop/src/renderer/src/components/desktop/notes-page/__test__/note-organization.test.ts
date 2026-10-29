import { describe, expect, it } from "vitest"
import { mergeNotes, reconcileOrganization } from "@rzx/client"
import { projectNoteDesktop, searchNoteOrganization } from "../note-organization"
import type { NoteView } from "../note-model"

const notes: NoteView[] = ["a", "b", "c"].map((id, index) => ({
  draftId: id,
  noteId: id,
  content: `${id}\nbody ${id}`,
  createdAt: 1,
  updatedAt: 10 - index,
  revision: 1,
  recovered: false,
}))
describe("note organization projections", () => {
  it("keeps manual order when body timestamps change and projects pins separately", () => {
    const value = reconcileOrganization(undefined, ["c", "b", "a"]).organization
    const projection = projectNoteDesktop(
      value,
      notes.map((note) => ({ ...note, pinned: note.noteId === "b", updatedAt: 100 }))
    )
    expect(projection.pinned.map((item) => item.id)).toEqual(["b"])
    expect(projection.desktop.map((item) => item.id)).toEqual(["c", "a"])
  })
  it("finds folder names and member body matches with membership", () => {
    const value = mergeNotes(reconcileOrganization(undefined, ["a", "b", "c"]).organization, {
      activeNoteId: "a",
      targetNoteId: "b",
      folderId: "f1",
      folderName: "工作",
      now: 1,
    })
    expect(searchNoteOrganization(value, notes, "body a").notes[0]?.folderName).toBe("工作")
    expect(searchNoteOrganization(value, notes, "工作").folders).toEqual([
      { type: "folder", id: "f1" },
    ])
  })
})

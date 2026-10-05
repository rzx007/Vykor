import { useState } from "react"

import { NoteDeleteDialog } from "./note-delete-dialog"
import { NoteEditor } from "./note-editor"
import { NoteList } from "./note-list"
import { useNotesController } from "./use-notes-controller"

export function NotesPage(): React.JSX.Element {
  const notes = useNotesController()
  const [deleteOpen, setDeleteOpen] = useState(false)
  const selected = notes.notes.find((note) => note.draftId === notes.selectedKey)

  return (
    <section className="grid h-full min-h-0 w-full grid-cols-[minmax(230px,280px)_minmax(0,1fr)] overflow-hidden bg-background">
      <NoteList
        notes={notes.visibleNotes}
        selectedKey={notes.selectedKey}
        query={notes.query}
        loading={notes.status === "loading"}
        onQueryChange={notes.setQuery}
        onCreate={notes.createDraft}
        onSelect={(draftId) => void notes.select(draftId)}
      />
      <NoteEditor
        selected={selected}
        content={notes.content}
        status={notes.status}
        error={notes.error}
        onChange={notes.edit}
        onRetry={() => void notes.retrySave()}
        onReloadConflict={() => void notes.reloadConflict()}
        onSaveConflictAsNew={() => void notes.saveConflictAsNew()}
        onDelete={() => setDeleteOpen(true)}
      />
      <NoteDeleteDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        onConfirm={() => {
          setDeleteOpen(false)
          void notes.removeSelected()
        }}
      />
    </section>
  )
}

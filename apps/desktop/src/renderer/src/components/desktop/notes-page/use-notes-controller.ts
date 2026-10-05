import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import type { DesktopNote } from "@shared/note-types"
import { filterAndSortNotes, noteViewFromRecord, type NoteView } from "./note-model"
import {
  createNoteRecoveryPort,
  readRecoveryDrafts,
  readSelectedNoteId,
  removeRecoveryDraft,
  writeSelectedNoteId,
  type NoteRecoveryDraft,
} from "./note-recovery"
import {
  NoteSaveCoordinator,
  type NoteSaveSnapshot,
  type NoteSaveStatus,
} from "./note-save-coordinator"

export interface NotesController {
  notes: NoteView[]
  visibleNotes: NoteView[]
  selectedKey: string | null
  content: string
  query: string
  status: "loading" | NoteSaveStatus
  error: string | null
  setQuery(value: string): void
  createDraft(): void
  select(draftId: string): Promise<void>
  edit(content: string): void
  retrySave(): Promise<void>
  reloadConflict(): Promise<void>
  saveConflictAsNew(): Promise<void>
  removeSelected(): Promise<void>
}

export function useNotesController(): NotesController {
  const [notes, setNotes] = useState<NoteView[]>([])
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [query, setQuery] = useState("")
  const [status, setStatus] = useState<NotesController["status"]>("loading")
  const [error, setError] = useState<string | null>(null)
  const notesRef = useRef<NoteView[]>([])
  const selectedKeyRef = useRef<string | null>(null)
  const coordinators = useRef(new Map<string, NoteSaveCoordinator>())
  const recovery = useMemo(() => createNoteRecoveryPort(), [])

  const commitNotes = useCallback(
    (update: NoteView[] | ((current: NoteView[]) => NoteView[])): NoteView[] => {
      const next = typeof update === "function" ? update(notesRef.current) : update
      notesRef.current = next
      setNotes(next)
      return next
    },
    []
  )

  const commitSelection = useCallback((draftId: string | null): void => {
    selectedKeyRef.current = draftId
    setSelectedKey(draftId)
    const selected = notesRef.current.find((note) => note.draftId === draftId)
    writeSelectedNoteId(window.localStorage, selected?.noteId ?? null)
    const snapshot = draftId ? coordinators.current.get(draftId)?.snapshot() : undefined
    setStatus(snapshot?.status ?? "idle")
    setError(snapshot?.error ?? null)
  }, [])

  const applySnapshot = useCallback(
    (draftId: string, snapshot: NoteSaveSnapshot): void => {
      if (snapshot.record) {
        commitNotes((current) =>
          current.map((note) =>
            note.draftId === draftId
              ? {
                  ...note,
                  noteId: snapshot.record!.id,
                  revision: snapshot.record!.revision,
                  createdAt: snapshot.record!.createdAt,
                  updatedAt: snapshot.record!.updatedAt,
                  recovered: false,
                }
              : note
          )
        )
        if (selectedKeyRef.current === draftId) {
          writeSelectedNoteId(window.localStorage, snapshot.record.id)
        }
      }
      if (selectedKeyRef.current === draftId) {
        setStatus(snapshot.status)
        setError(snapshot.error)
      }
    },
    [commitNotes]
  )

  const installCoordinator = useCallback(
    (view: NoteView, record?: DesktopNote): NoteSaveCoordinator => {
      const coordinator = new NoteSaveCoordinator({
        api: window.desktop.notes,
        recovery,
        ...(record ? { record } : {}),
        onChange: (snapshot) => applySnapshot(view.draftId, snapshot),
      })
      coordinators.current.set(view.draftId, coordinator)
      return coordinator
    },
    [applySnapshot, recovery]
  )

  const createLocalDraft = useCallback(
    (content = "", restored?: NoteRecoveryDraft): NoteView => {
      const now = restored?.updatedAt ?? Date.now()
      const view: NoteView = {
        draftId: restored?.draftId ?? crypto.randomUUID(),
        noteId: null,
        content,
        revision: null,
        createdAt: now,
        updatedAt: now,
        recovered: Boolean(restored),
      }
      installCoordinator(view)
      return view
    },
    [installCoordinator]
  )

  useEffect(() => {
    let disposed = false
    const activeCoordinators = coordinators.current
    void window.desktop.notes
      .list()
      .then((records) => {
        if (disposed) return
        const remainingRecovery = new Map(
          readRecoveryDrafts().map((draft) => [draft.draftId, draft])
        )
        const views = records.map((record) => {
          const restored = [...remainingRecovery.values()]
            .filter((draft) => draft.noteId === record.id)
            .sort((left, right) => right.updatedAt - left.updatedAt)[0]
          if (!restored) {
            const view = noteViewFromRecord(record)
            installCoordinator(view, record)
            return view
          }
          remainingRecovery.delete(restored.draftId)
          const view: NoteView = {
            draftId: restored.draftId,
            noteId: record.id,
            content: restored.content,
            revision: record.revision,
            createdAt: record.createdAt,
            updatedAt: restored.updatedAt,
            recovered: true,
          }
          installCoordinator(view, record).stage(restored)
          return view
        })
        for (const restored of remainingRecovery.values()) {
          const view = createLocalDraft(restored.content, restored)
          views.push(view)
          coordinators.current.get(view.draftId)?.stage({
            ...restored,
            noteId: null,
            baseRevision: null,
          })
        }
        const initial = filterAndSortNotes(views, "")
        if (initial.length === 0) initial.push(createLocalDraft())
        commitNotes(initial)
        const lastId = readSelectedNoteId()
        const selected = initial.find((note) => note.noteId === lastId) ?? initial[0]!
        commitSelection(selected.draftId)
      })
      .catch((cause) => {
        if (disposed) return
        setStatus("error")
        setError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => {
      disposed = true
      for (const coordinator of activeCoordinators.values()) coordinator.dispose()
      activeCoordinators.clear()
    }
  }, [commitNotes, commitSelection, createLocalDraft, installCoordinator])

  const select = useCallback(
    async (draftId: string): Promise<void> => {
      if (draftId === selectedKeyRef.current) return
      const currentKey = selectedKeyRef.current
      if (currentKey) await coordinators.current.get(currentKey)?.flush()
      if (notesRef.current.some((note) => note.draftId === draftId)) commitSelection(draftId)
    },
    [commitSelection]
  )

  const createDraft = useCallback((): void => {
    const currentKey = selectedKeyRef.current
    if (currentKey) void coordinators.current.get(currentKey)?.flush()
    const view = createLocalDraft()
    commitNotes((current) => [view, ...current])
    commitSelection(view.draftId)
  }, [commitNotes, commitSelection, createLocalDraft])

  const edit = useCallback(
    (content: string): void => {
      const draftId = selectedKeyRef.current
      const current = notesRef.current.find((note) => note.draftId === draftId)
      if (!draftId || !current) return
      const updated = { ...current, content, updatedAt: Date.now() }
      commitNotes((items) => items.map((note) => (note.draftId === draftId ? updated : note)))
      coordinators.current.get(draftId)?.stage({
        draftId,
        noteId: current.noteId,
        baseRevision: current.revision,
        content,
        updatedAt: updated.updatedAt,
      })
    },
    [commitNotes]
  )

  const retrySave = useCallback(async (): Promise<void> => {
    const draftId = selectedKeyRef.current
    if (draftId) await coordinators.current.get(draftId)?.retry()
  }, [])

  const reloadConflict = useCallback(async (): Promise<void> => {
    const draftId = selectedKeyRef.current
    const current = notesRef.current.find((note) => note.draftId === draftId)
    if (!draftId || !current?.noteId) return
    const record = (await window.desktop.notes.list()).find((note) => note.id === current.noteId)
    if (!record) {
      setStatus("error")
      setError(`Note not found: ${current.noteId}`)
      return
    }
    removeRecoveryDraft(window.localStorage, draftId)
    coordinators.current.get(draftId)?.dispose()
    const view = { ...noteViewFromRecord(record), draftId }
    installCoordinator(view, record)
    commitNotes((items) => items.map((note) => (note.draftId === draftId ? view : note)))
    setStatus("saved")
    setError(null)
  }, [commitNotes, installCoordinator])

  const saveConflictAsNew = useCallback(async (): Promise<void> => {
    const current = notesRef.current.find((note) => note.draftId === selectedKeyRef.current)
    if (!current) return
    const view = createLocalDraft(current.content)
    commitNotes((items) => [view, ...items])
    commitSelection(view.draftId)
    coordinators.current.get(view.draftId)?.stage({
      draftId: view.draftId,
      noteId: null,
      baseRevision: null,
      content: view.content,
      updatedAt: view.updatedAt,
    })
    await coordinators.current.get(view.draftId)?.flush()
  }, [commitNotes, commitSelection, createLocalDraft])

  const removeSelected = useCallback(async (): Promise<void> => {
    const draftId = selectedKeyRef.current
    const current = notesRef.current.find((note) => note.draftId === draftId)
    if (!draftId || !current) return
    try {
      const coordinator = coordinators.current.get(draftId)
      await coordinator?.flush()
      const persistedId = coordinator?.snapshot().record?.id ?? current.noteId
      if (persistedId) await window.desktop.notes.remove(persistedId)
      removeRecoveryDraft(window.localStorage, draftId)
      coordinator?.dispose()
      coordinators.current.delete(draftId)
      const remaining = notesRef.current.filter((note) => note.draftId !== draftId)
      if (remaining.length === 0) remaining.push(createLocalDraft())
      commitNotes(remaining)
      commitSelection(filterAndSortNotes(remaining, "")[0]!.draftId)
    } catch (cause) {
      setStatus("error")
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [commitNotes, commitSelection, createLocalDraft])

  const selected = notes.find((note) => note.draftId === selectedKey)
  const visibleNotes = useMemo(
    () =>
      filterAndSortNotes(
        notes.filter((note) => note.noteId !== null || Boolean(note.content.trim())),
        query
      ),
    [notes, query]
  )
  return {
    notes,
    visibleNotes,
    selectedKey,
    content: selected?.content ?? "",
    query,
    status,
    error,
    setQuery,
    createDraft,
    select,
    edit,
    retrySave,
    reloadConflict,
    saveConflictAsNew,
    removeSelected,
  }
}

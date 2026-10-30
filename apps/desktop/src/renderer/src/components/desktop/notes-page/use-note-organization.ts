import { useCallback, useEffect, useRef, useState } from "react"
import {
  dissolveFolder,
  mergeNotes,
  moveNoteToDesktop,
  moveNoteToFolder,
  renameFolder,
  reorderInContainer,
  type NoteOrganizationV1Record,
} from "@vykor/application-client"
import type { DesktopNoteOrganizationSnapshot } from "@shared/note-types"
import { describeNote, type NoteView } from "./note-model"

type Change = (organization: NoteOrganizationV1Record) => NoteOrganizationV1Record
type Operation = { transform: Change; rollback?: () => void; apply?: () => void }

export function useNoteOrganization(notes: readonly NoteView[]) {
  const [snapshot, setSnapshot] = useState<DesktopNoteOrganizationSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [recoveryWarning, setRecoveryWarning] = useState<string>()
  const latest = useRef(snapshot)
  const confirmed = useRef(snapshot)
  const queue = useRef(Promise.resolve())
  const pending = useRef(new Set<Operation>())
  const generation = useRef(0)
  const refreshSequence = useRef(0)
  const refreshLater = useRef(false)
  const mounted = useRef(true)
  const retryChange = useRef<Operation | null>(null)
  const publish = useCallback((value: DesktopNoteOrganizationSnapshot): void => {
    latest.current = value
    if (mounted.current) {
      setSnapshot(value)
      if (value.warning && !value.readOnly) setRecoveryWarning(value.warning)
    }
  }, [])
  const refresh = useCallback(async (): Promise<void> => {
    if (pending.current.size) {
      refreshLater.current = true
      return
    }
    const revision = generation.current
    const sequence = ++refreshSequence.current
    try {
      const value = await window.desktop.notes.organization()
      if (
        !mounted.current ||
        pending.current.size ||
        revision !== generation.current ||
        sequence !== refreshSequence.current
      )
        return
      confirmed.current = value
      if (!retryChange.current) setError(null)
      publish(value)
    } catch (cause) {
      if (
        mounted.current &&
        !pending.current.size &&
        revision === generation.current &&
        sequence === refreshSequence.current
      )
        setError("无法读取便签分类：" + String(cause))
    }
  }, [publish])
  const noteIds = notes
    .flatMap((note) => (note.noteId ? [note.noteId] : []))
    .sort()
    .join("\n")
  useEffect(() => {
    mounted.current = true
    window.addEventListener("focus", refresh)
    return () => {
      mounted.current = false
      window.removeEventListener("focus", refresh)
    }
  }, [refresh])
  useEffect(() => {
    void refresh()
  }, [noteIds, refresh])

  const change = useCallback(
    (transform: Change, rollback?: () => void, apply?: () => void): Promise<boolean> => {
      const before = latest.current
      if (!before || before.readOnly) return Promise.resolve(false)
      let next: NoteOrganizationV1Record
      try {
        next = transform(before.organization)
      } catch (cause) {
        setError(String(cause))
        rollback?.()
        return Promise.resolve(false)
      }
      apply?.()
      if (JSON.stringify(next) === JSON.stringify(before.organization)) {
        retryChange.current = null
        setError(null)
        return Promise.resolve(true)
      }
      generation.current += 1
      const entry = { transform, rollback, apply }
      pending.current.add(entry)
      publish({ ...before, organization: next })
      setSaving(true)
      setError(null)
      let resolve!: (success: boolean) => void
      const result = new Promise<boolean>((done) => {
        resolve = done
      })
      queue.current = queue.current
        .then(async () => {
          if (!pending.current.has(entry)) {
            resolve(false)
            return
          }
          const base = confirmed.current!
          try {
            const value = await window.desktop.notes.saveOrganization({
              organization: transform(base.organization),
              expectedEtag: base.etag,
            })
            confirmed.current = value
            pending.current.delete(entry)
            if (!pending.current.size) publish(value)
            retryChange.current = null
            resolve(true)
          } catch (cause) {
            // 一次失败撤销全部未确认布局，排队中的后续操作不会继续覆盖磁盘。
            for (const operation of [...pending.current].reverse()) operation.rollback?.()
            pending.current.clear()
            generation.current += 1
            publish(confirmed.current!)
            retryChange.current = entry
            if (mounted.current) setError("整理未保存，已恢复原位置：" + String(cause))
            refreshLater.current = true
            resolve(false)
          } finally {
            if (!pending.current.size && mounted.current) setSaving(false)
            if (!pending.current.size && refreshLater.current) {
              refreshLater.current = false
              await refresh()
            }
          }
        })
        .catch((cause) => {
          if (mounted.current) setError(String(cause))
          resolve(false)
        })
      return result
    },
    [publish, refresh]
  )

  return {
    snapshot,
    saving,
    error,
    readOnly: !snapshot || snapshot.readOnly,
    warning: snapshot?.warning ?? recoveryWarning,
    refresh,
    change,
    retry: () =>
      retryChange.current
        ? change(
            retryChange.current.transform,
            retryChange.current.rollback,
            retryChange.current.apply
          )
        : refresh(),
    reorder: (containerId: string, activeId: string, toIndex: number) =>
      change((value) => reorderInContainer(value, { containerId, activeId, toIndex })),
    mergeNotes: async (activeNoteId: string, targetNoteId: string): Promise<string | null> => {
      const target = notes.find((note) => note.noteId === targetNoteId)
      const folderId = crypto.randomUUID()
      const folderName = describeNote(target?.content ?? "").title
      const now = Date.now()
      const saved = await change((value) =>
        mergeNotes(value, { activeNoteId, targetNoteId, folderId, folderName, now })
      )
      return saved ? folderId : null
    },
    moveToFolder: (noteId: string, folderId: string, index?: number) =>
      change((value) => moveNoteToFolder(value, { noteId, folderId, index })),
    moveToDesktop: (noteId: string, desktopIndex: number) =>
      change((value) => moveNoteToDesktop(value, { noteId, desktopIndex })),
    renameFolder: (folderId: string, name: string) =>
      change((value) => renameFolder(value, { folderId, name, now: Date.now() })),
    dissolveFolder: (folderId: string) => change((value) => dissolveFolder(value, folderId)),
  }
}

export type NoteOrganizationController = ReturnType<typeof useNoteOrganization>

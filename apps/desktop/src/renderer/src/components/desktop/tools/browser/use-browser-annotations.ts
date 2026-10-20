import { useEffect, useRef, useState } from "react"
import type { BrowserAnnotationSnapshot } from "@shared/browser-annotation"

export type BrowserAnnotationHookOptions = { tabId: string; visible: boolean; ready: boolean }
export type BrowserAnnotationUi = {
  snapshot: BrowserAnnotationSnapshot | null; draft: string; pending: boolean; error: string | null
  selection: BrowserAnnotationSnapshot["selection"]; viewedAnnotationId: string | null
  editing: boolean; listOpen: boolean
  setDraft(value: string): void
  startPicking(): Promise<void>; showSaved(): Promise<void>; hide(): Promise<void>; save(): Promise<void>
  focus(annotationId: string): Promise<void>; remove(annotationId: string): Promise<void>; cancelEditor(): void
}

export function useBrowserAnnotations(options: BrowserAnnotationHookOptions): BrowserAnnotationUi {
  const [snapshot, setSnapshot] = useState<BrowserAnnotationSnapshot | null>(null)
  const [draft, setDraft] = useState("")
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [viewedAnnotationId, setViewed] = useState<string | null>(null)
  const [listOpen, setListOpen] = useState(false)
  const live = useRef(options); live.current = options
  const current = useRef<BrowserAnnotationSnapshot | null>(null)
  const draftRef = useRef(draft); draftRef.current = draft
  const editingRef = useRef(editing); editingRef.current = editing
  const generation = useRef(0), operation = useRef(0), busy = useRef(false)
  const eventKey = useRef("")

  function accept(next: BrowserAnnotationSnapshot): void {
    const previous = current.current
    current.current = next
    // The page contains at most 20 bounded comments; keep unchanged polls out of React rendering.
    setSnapshot(old => JSON.stringify(old) === JSON.stringify(next) ? old : next)
    if (previous && previous.pageRevision !== next.pageRevision) {
      setViewed(null); setEditing(Boolean(draftRef.current))
      if (draftRef.current) setError("页面已变化，草稿已保留，请重新选择目标")
    }
    const key = `${next.pageRevision}/${next.interactionVersion}/${next.eventSequence}`
    if (eventKey.current === key) return
    eventKey.current = key
    if (next.selection) { setEditing(true); setViewed(null); setListOpen(false) }
    else if (next.focusedAnnotationId) { setViewed(next.focusedAnnotationId); setEditing(false); setListOpen(true) }
    else if (previous && previous.pageRevision === next.pageRevision && previous.interactionVersion === next.interactionVersion && next.eventSequence > previous.eventSequence) {
      // An explicit Escape in the guest; ordinary polling or suspension never discards a draft.
      setEditing(false); setViewed(null)
      if (editingRef.current) { setDraft(""); draftRef.current = "" }
    }
  }

  useEffect(() => {
    const token = ++generation.current
    let timer: ReturnType<typeof setTimeout> | undefined
    const enabled = options.visible && options.ready
    if (!enabled) {
      operation.current++; busy.current = false
      const previous = current.current
      if (previous && previous.mode !== "off") void window.desktop.browser.setAnnotationMode({ tabId: options.tabId, pageRevision: previous.pageRevision, mode: "off" }).catch(() => undefined)
      current.current = previous ? { ...previous, mode: "off", selection: null } : null
      setSnapshot(current.current); setViewed(null); setPending(false); setEditing(false)
      if (draftRef.current) setError("草稿已保留，请重新选择目标")
    }
    const poll = async (): Promise<void> => {
      if (generation.current !== token) return
      const operationToken = operation.current
      try {
        if (!busy.current) {
          const next = await window.desktop.browser.readAnnotations({ tabId: options.tabId })
          if (generation.current === token && operation.current === operationToken) accept(next)
        }
      } catch (cause) {
        if (generation.current === token) setError(message(cause))
      } finally {
        if (generation.current === token) timer = setTimeout(() => void poll(), 100)
      }
    }
    if (enabled) void poll()
    return () => {
      generation.current++; if (timer) clearTimeout(timer)
      const previous = current.current
      if (previous?.mode !== "off" && previous) void window.desktop.browser.setAnnotationMode({ tabId: options.tabId, pageRevision: previous.pageRevision, mode: "off" }).catch(() => undefined)
    }
  }, [options.tabId, options.visible, options.ready])

  async function perform(action: (page: BrowserAnnotationSnapshot) => Promise<BrowserAnnotationSnapshot>): Promise<BrowserAnnotationSnapshot | null> {
    if (busy.current || !live.current.visible || !live.current.ready) return null
    const token = generation.current, op = ++operation.current
    busy.current = true; setPending(true); setError(null)
    try {
      const page = current.current ?? await window.desktop.browser.readAnnotations({ tabId: options.tabId })
      const next = await action(page)
      if (generation.current !== token) return null
      accept(next)
      return next
    } catch (cause) {
      if (generation.current === token) {
        setError(message(cause))
        const page = current.current
        if (page) { current.current = { ...page, selection: null }; setSnapshot(current.current) }
      }
      return null
    } finally {
      if (operation.current === op) { busy.current = false; setPending(false) }
    }
  }

  async function startPicking(): Promise<void> {
    const result = await perform(page => window.desktop.browser.setAnnotationMode({ tabId: options.tabId, pageRevision: page.pageRevision, mode: "pick" }))
    if (result) { setListOpen(false); setViewed(null); setEditing(Boolean(draftRef.current)) }
  }
  async function showSaved(): Promise<void> {
    const result = await perform(page => window.desktop.browser.setAnnotationMode({ tabId: options.tabId, pageRevision: page.pageRevision, mode: "review" }))
    if (result) { setListOpen(true); setEditing(false); setViewed(null) }
  }
  async function hide(): Promise<void> {
    const result = await perform(page => window.desktop.browser.setAnnotationMode({ tabId: options.tabId, pageRevision: page.pageRevision, mode: "off" }))
    if (result) { setListOpen(false); setViewed(null); setEditing(false) }
  }
  async function save(): Promise<void> {
    if (!current.current?.selection || !draftRef.current.trim()) return
    const result = await perform(page => window.desktop.browser.addAnnotation({ tabId: options.tabId, pageRevision: page.pageRevision,
      selectionId: page.selection!.selectionId, comment: draftRef.current }))
    if (result) { setDraft(""); draftRef.current = ""; setEditing(false); setViewed(null) }
  }
  async function focus(annotationId: string): Promise<void> {
    const result = await perform(page => window.desktop.browser.focusAnnotation({ tabId: options.tabId, pageRevision: page.pageRevision, annotationId }))
    if (result) { setViewed(annotationId); setEditing(false); setListOpen(true) }
  }
  async function remove(annotationId: string): Promise<void> {
    const result = await perform(page => window.desktop.browser.removeAnnotation({ tabId: options.tabId, pageRevision: page.pageRevision, annotationId }))
    if (result && viewedAnnotationId === annotationId) setViewed(null)
  }
  function cancelEditor(): void {
    if (editing) {
      setDraft(""); draftRef.current = ""; setEditing(false)
      void startPicking()
    }
    setViewed(null); setError(null)
  }
  return { snapshot, draft, pending, error, editing, listOpen, selection: options.visible && options.ready && editing ? snapshot?.selection ?? null : null,
    viewedAnnotationId, setDraft, startPicking, showSaved, hide, save, focus, remove, cancelEditor }
}

function message(cause: unknown): string {
  return (cause instanceof Error ? cause.message : String(cause)).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "")
}

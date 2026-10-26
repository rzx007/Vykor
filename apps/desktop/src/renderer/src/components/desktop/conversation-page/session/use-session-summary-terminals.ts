import { useEffect, useMemo, useRef, useState } from "react"
import type { DesktopSessionPart, DesktopSessionView } from "@shared/session-types"
import type { DesktopTerminalEvent, DesktopTerminalRecord } from "@shared/terminal-types"
import { terminalErrorMessage } from "@renderer/components/desktop/tools/terminal/terminal-display"
import { toolOutputText } from "../message/models/message-content"

type SummaryTerminals = {
  records: DesktopTerminalRecord[]
  loading: boolean
  error: string | null
}
type State = SummaryTerminals & { sessionId: string | null }
type StateEvent = Extract<DesktopTerminalEvent, { type: "status" | "exit" }>
const empty: SummaryTerminals = { records: [], loading: false, error: null }
const terminalCreators = new Set(["TerminalOpen", "Shell", "BackgroundShellCreate"])

// Identity comes from a successful native tool result, never prose or a command argument.
function terminalToolDiscovery(
  allParts: DesktopSessionPart[] | undefined,
  sessionId: string | null
): { ids: string[]; creating: string[] } {
  if (!sessionId) return { ids: [], creating: [] }
  const parts = allParts?.filter((part) => part.sessionId === sessionId) ?? []
  const calls = new Map(
    parts
      .filter((part) => part.type === "tool")
      .map((part) => [part.toolUseId ?? part.id, part.toolName])
  )
  const ids = new Set<string>()
  const creating = new Set<string>()
  for (const part of parts) {
    const name = part.toolName ?? calls.get(part.toolUseId ?? "")
    if (!terminalCreators.has(name ?? "")) continue
    if (part.type === "tool" && (part.status === "pending" || part.status === "running")) {
      creating.add(`${part.id}:${part.status}`)
    }
    if (
      (part.type !== "tool" && part.type !== "tool_result") ||
      part.status !== "completed" ||
      part.isError
    )
      continue
    if (
      part.metadata.executionState === "not_started" ||
      part.metadata.executionState === "unknown"
    )
      continue
    const text = toolOutputText(part.output)
    if (!text) continue
    try {
      const payload = JSON.parse(text)
      const id = payload?.terminal?.id
      if (
        payload?.kind === "terminal" &&
        payload.action === "open" &&
        typeof id === "string" &&
        id.trim()
      )
        ids.add(id)
    } catch {
      /* Preview or plain text does not establish terminal ownership. */
    }
  }
  return { ids: [...ids].sort(), creating: [...creating].sort() }
}

function belongsToSession(
  record: DesktopTerminalRecord,
  sessionId: string,
  toolIds: Set<string>
): boolean {
  if (record.source !== "agent") return false
  const scopeOwner = record.scope.kind === "session" ? record.scope.sessionId : undefined
  // A transcript reference cannot override an explicit owner from another session.
  if (
    (record.sessionId && record.sessionId !== sessionId) ||
    (scopeOwner && scopeOwner !== sessionId)
  )
    return false
  return record.sessionId === sessionId || scopeOwner === sessionId || toolIds.has(record.id)
}

function applyEvent(record: DesktopTerminalRecord, event: StateEvent): DesktopTerminalRecord {
  if (event.type === "status") return { ...record, status: event.status }
  return {
    ...record,
    status:
      record.status === "stopping" || record.status === "killed"
        ? "killed"
        : event.exitCode === 0
          ? "completed"
          : "failed",
    exitCode: event.exitCode,
  }
}

/** Mount at session level so collapsed summaries and virtual message rows share one live feed. */
export function useSessionSummaryTerminals(view: DesktopSessionView | null): SummaryTerminals {
  const sessionId = view?.session.id ?? null
  const syncStatus = view?.syncStatus
  const parts = view?.parts
  const identityKey = useMemo(
    () => JSON.stringify(terminalToolDiscovery(parts, sessionId)),
    [parts, sessionId]
  )
  const [state, setState] = useState<State>({ ...empty, sessionId: null })
  const stateRef = useRef(state)
  const eventHandlerRef = useRef<(event: DesktopTerminalEvent) => void>(() => {})
  const refreshRef = useRef(() => {})

  // Keep this subscription independent of transcript updates and session switches.
  useEffect(() => {
    const api = window.desktop?.terminal
    if (!api) return
    const unsubscribe = api.onEvent((event) => eventHandlerRef.current(event))
    const focus = () => refreshRef.current()
    window.addEventListener("focus", focus)
    return () => {
      unsubscribe()
      window.removeEventListener("focus", focus)
    }
  }, [])

  useEffect(() => {
    const api = window.desktop?.terminal
    let disposed = false
    let requestId = 0
    let revision = 0
    let pending = false
    const events: { revision: number; event: StateEvent }[] = []
    const discovery = JSON.parse(identityKey) as { ids: string[]; creating: string[] }
    const toolIds = new Set(discovery.ids)
    let current = stateRef.current.sessionId === sessionId ? stateRef.current.records : []
    let error: string | null = null
    const publish = (loading: boolean) => {
      if (disposed) return
      const next = { sessionId, records: current, loading, error }
      stateRef.current = next
      setState(next)
    }
    if (!sessionId || !api) {
      publish(false)
      return
    }

    const refresh = () => {
      const request = ++requestId
      const startRevision = revision
      pending = true
      publish(true)
      // The existing API only supports list(); ownership is checked before exposing any record.
      void api
        .list()
        .then((records) => {
          if (disposed || request !== requestId) return
          const updates = events.filter((update) => update.revision > startRevision)
          const nextRecords = records
            .filter((record) => belongsToSession(record, sessionId, toolIds))
            .map((record) => {
              let next = record
              const previous = current.find((candidate) => candidate.id === record.id)
              // Terminal IDs are not restarted. A stale read cannot make a stopped process run again.
              if (
                previous &&
                previous.status !== "running" &&
                (record.status === "running" ||
                  (record.status === "stopping" && previous.status !== "stopping"))
              ) {
                next = {
                  ...record,
                  status: previous.status,
                  exitCode: previous.exitCode,
                  exitedAt: previous.exitedAt ?? record.exitedAt,
                }
              }
              for (const update of updates) {
                if (update.event.terminalId === record.id) next = applyEvent(next, update.event)
              }
              return next
            })
          const seen = new Set(nextRecords.map((record) => record.id))
          // A newer event also takes precedence over an older list's omission.
          for (const record of current) {
            if (
              !seen.has(record.id) &&
              updates.some((update) => update.event.terminalId === record.id)
            )
              nextRecords.push(record)
          }
          current = nextRecords
          events.length = 0
          pending = false
          error = null
          publish(false)
        })
        .catch((caught: unknown) => {
          if (disposed || request !== requestId) return
          events.length = 0
          pending = false
          error = terminalErrorMessage(caught)
          publish(false)
        })
    }
    eventHandlerRef.current = (event) => {
      if (disposed) return
      const related = current.some((record) => record.id === event.terminalId)
      if (event.type === "status" || event.type === "exit") {
        revision += 1
        // During a read, retain status-only events until its returned owner can be checked.
        if (pending) events.push({ revision, event })
        if (!related) return
        current = current.map((record) =>
          record.id === event.terminalId ? applyEvent(record, event) : record
        )
        publish(pending)
        // Read the daemon's actual exitedAt; the event itself carries no timestamp.
        if (event.type === "exit" && !pending) refresh()
      } else if (event.type === "error" && related) {
        error = event.message
        publish(pending)
        refresh()
      }
    }
    refreshRef.current = refresh
    refresh()
    // Event transport may miss an exit. Only known active terminals need periodic recovery.
    const timer = window.setInterval(() => {
      if (
        !pending &&
        (error ||
          discovery.creating.length > 0 ||
          current.some((record) => record.status === "running" || record.status === "stopping"))
      )
        refresh()
    }, 10_000)
    return () => {
      disposed = true
      window.clearInterval(timer)
      eventHandlerRef.current = () => {}
      refreshRef.current = () => {}
    }
  }, [sessionId, identityKey, syncStatus])

  if (state.sessionId !== sessionId) return { ...empty, loading: Boolean(sessionId) }
  const { records, loading, error } = state
  return { records, loading, error }
}

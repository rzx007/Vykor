// @vitest-environment jsdom
import { act, useEffect } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { DesktopSessionPart, DesktopSessionView } from "@shared/session-types"
import type { DesktopTerminalEvent, DesktopTerminalRecord } from "@shared/terminal-types"
import { useSessionSummaryTerminals } from "../use-session-summary-terminals"

const terminal: DesktopTerminalRecord = {
  id: "terminal-1",
  name: "preview",
  command: "pnpm dev",
  cwd: "/repo",
  shell: "/bin/sh",
  scope: { kind: "session", sessionId: "chat" },
  sessionId: "chat",
  source: "agent",
  runtime: "local",
  status: "running",
  cols: 80,
  rows: 24,
  createdAt: "2026-10-21T00:00:00Z",
}

function view(id = "chat"): DesktopSessionView {
  return {
    cursor: 0,
    syncStatus: "connected",
    session: {
      id,
      cwd: "/repo",
      title: id,
      model: "test",
      status: "idle",
      metadata: {},
      createdAt: 1,
      updatedAt: 1,
    },
    inputs: [],
    messages: [],
    parts: [],
    runs: [],
    tasks: [],
    permissions: [],
  }
}

function openPart(id: string, extra: Partial<DesktopSessionPart> = {}): DesktopSessionPart {
  return {
    id,
    sessionId: "chat",
    messageId: "assistant",
    seq: 1,
    type: "tool",
    toolName: "TerminalOpen",
    status: "completed",
    output: {
      content: [
        {
          type: "text",
          text: JSON.stringify({ kind: "terminal", action: "open", terminal: { id } }),
        },
      ],
    },
    metadata: {},
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  } as DesktopSessionPart
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

let root: Root
let container: HTMLDivElement
let records: DesktopTerminalRecord[]
let listeners: Set<(event: DesktopTerminalEvent) => void>
let list: ReturnType<typeof vi.fn>
let onEvent: ReturnType<typeof vi.fn>
let latest: ReturnType<typeof useSessionSummaryTerminals>

function Probe({ current }: { current: DesktopSessionView | null }) {
  const result = useSessionSummaryTerminals(current)
  useEffect(() => {
    latest = result
  }, [result])
  return null
}

async function render(current: DesktopSessionView | null = view()) {
  await act(async () => root.render(<Probe current={current} />))
}

async function emit(event: DesktopTerminalEvent) {
  await act(async () => {
    for (const listener of listeners) listener(event)
  })
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  records = [terminal]
  listeners = new Set()
  list = vi.fn(async () => records)
  onEvent = vi.fn((listener: (event: DesktopTerminalEvent) => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  })
  vi.stubGlobal("desktop", { terminal: { list, onEvent } })
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it("only includes agent terminals explicitly owned by this session", async () => {
  records = [
    terminal,
    { ...terminal, id: "scope-only", sessionId: undefined },
    { ...terminal, id: "project-owned", scope: { kind: "project", projectId: "project" } },
    { ...terminal, id: "user", source: "user" },
    {
      ...terminal,
      id: "foreign",
      sessionId: "other",
      scope: { kind: "session", sessionId: "other" },
    },
    {
      ...terminal,
      id: "workspace",
      sessionId: undefined,
      scope: { kind: "project", projectId: "project" },
    },
    { ...terminal, id: "conflicting", sessionId: "other" },
  ]
  await render()
  expect(latest.records.map((record) => record.id)).toEqual([
    "terminal-1",
    "scope-only",
    "project-owned",
  ])
  expect(latest.loading).toBe(false)
  expect(latest.error).toBeNull()
})

it("uses successful TerminalOpen structure only for ownerless actual records", async () => {
  const current = view()
  current.parts = [
    openPart("legacy"),
    openPart("foreign", { sessionId: "other" }),
    openPart("failed", { isError: true }),
    openPart("pending", { status: "running" }),
    openPart("not-started", { metadata: { executionState: "not_started" } }),
    openPart("arbitrary", { toolName: "Read" }),
    openPart("text", { type: "text" }),
    openPart("wrong-owner"),
  ]
  records = [
    "legacy",
    "foreign",
    "failed",
    "pending",
    "not-started",
    "arbitrary",
    "text",
    "wrong-owner",
  ].map((id) => ({
    ...terminal,
    id,
    sessionId: id === "wrong-owner" ? "other" : undefined,
    scope: { kind: "project", projectId: "project" },
  }))
  await render(current)
  expect(latest.records.map((record) => record.id)).toEqual(["legacy"])
})

it("updates while its owner rerenders without adding subscriptions or querying unrelated events", async () => {
  await render()
  await render({ ...view(), cursor: 2 })
  expect(onEvent).toHaveBeenCalledTimes(1)
  const queries = list.mock.calls.length
  await emit({ type: "exit", terminalId: "unrelated", exitCode: 1 })
  await emit({ type: "error", terminalId: "unrelated", message: "unrelated error" })
  expect(list).toHaveBeenCalledTimes(queries)
  expect(latest.records[0]?.status).toBe("running")
  await emit({ type: "status", terminalId: terminal.id, status: "stopping" })
  await emit({ type: "exit", terminalId: terminal.id, exitCode: 0 })
  expect(latest.records[0]).toMatchObject({ status: "killed", exitCode: 0 })
})

it("merges events received during the initial list without losing other owned records", async () => {
  const initial = deferred<DesktopTerminalRecord[]>()
  list.mockReturnValueOnce(initial.promise)
  await render()
  expect(latest.loading).toBe(true)
  await emit({ type: "exit", terminalId: terminal.id, exitCode: 1 })
  await act(async () => initial.resolve([terminal, { ...terminal, id: "second" }]))
  expect(latest.records.map(({ id, status }) => ({ id, status }))).toEqual([
    { id: "terminal-1", status: "failed" },
    { id: "second", status: "running" },
  ])
  expect(latest.loading).toBe(false)
})

it("does not let an in-flight focus list overwrite newer stop and exit events", async () => {
  await render()
  const refresh = deferred<DesktopTerminalRecord[]>()
  list.mockReturnValueOnce(refresh.promise)
  await act(async () => window.dispatchEvent(new Event("focus")))
  await emit({ type: "status", terminalId: terminal.id, status: "stopping" })
  await emit({ type: "exit", terminalId: terminal.id, exitCode: 0 })
  await act(async () => refresh.resolve([terminal]))
  expect(latest.records[0]?.status).toBe("killed")
})

it("retains a known terminal whose newer exit arrived after an older list omitted it", async () => {
  await render()
  const refresh = deferred<DesktopTerminalRecord[]>()
  list.mockReturnValueOnce(refresh.promise)
  await act(async () => window.dispatchEvent(new Event("focus")))
  await emit({ type: "exit", terminalId: terminal.id, exitCode: 1 })
  await act(async () => refresh.resolve([]))
  expect(latest.records[0]).toMatchObject({ id: "terminal-1", status: "failed" })
  records = []
  await act(async () => window.dispatchEvent(new Event("focus")))
  expect(latest.records).toEqual([])
})

it("prevents old session responses and records from entering the newly selected session", async () => {
  const old = deferred<DesktopTerminalRecord[]>()
  const next = deferred<DesktopTerminalRecord[]>()
  list.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise)
  await render()
  await render(view("next"))
  expect(latest.records).toEqual([])
  await act(async () => old.resolve([terminal]))
  expect(latest.records).toEqual([])
  await act(async () =>
    next.resolve([
      {
        ...terminal,
        id: "next-terminal",
        sessionId: "next",
        scope: { kind: "session", sessionId: "next" },
      },
    ])
  )
  expect(latest.records.map((record) => record.id)).toEqual(["next-terminal"])
  expect(onEvent).toHaveBeenCalledTimes(1)
})

it("recovers missed events on focus and removes records absent after daemon restart", async () => {
  await render()
  records = [{ ...terminal, status: "completed", exitCode: 0, exitedAt: "2026-10-21T00:01:00Z" }]
  await act(async () => window.dispatchEvent(new Event("focus")))
  expect(latest.records[0]).toMatchObject({ status: "completed", exitedAt: "2026-10-21T00:01:00Z" })
  records = []
  await act(async () => window.dispatchEvent(new Event("focus")))
  expect(latest.records).toEqual([])
})

it("rechecks known running terminals periodically when exit delivery is lost", async () => {
  vi.useFakeTimers()
  await render()
  records = [{ ...terminal, status: "failed", exitCode: 1 }]
  await act(async () => vi.advanceTimersByTime(10_000))
  expect(latest.records[0]?.status).toBe("failed")
})

it("keeps the last confirmed record on list failure and recovers on focus", async () => {
  await render()
  list.mockRejectedValueOnce(new Error("daemon disconnected"))
  await act(async () => window.dispatchEvent(new Event("focus")))
  expect(latest.records[0]?.status).toBe("running")
  expect(latest.error).toBe("daemon disconnected")
  records = [{ ...terminal, status: "completed" }]
  await act(async () => window.dispatchEvent(new Event("focus")))
  expect(latest.records[0]?.status).toBe("completed")
  expect(latest.error).toBeNull()
})

it("uses list to recover related error events without treating the process as failed", async () => {
  await render()
  records = [{ ...terminal, status: "running" }]
  const queries = list.mock.calls.length
  await emit({ type: "error", terminalId: terminal.id, message: "transport problem" })
  expect(list).toHaveBeenCalledTimes(queries + 1)
  expect(latest.records[0]?.status).toBe("running")
})

it("recovers the daemon exit timestamp after an exit event without inventing a local timestamp", async () => {
  await render()
  records = [{ ...terminal, status: "completed", exitCode: 0, exitedAt: "2026-10-21T00:01:00Z" }]
  await emit({ type: "exit", terminalId: terminal.id, exitCode: 0 })
  expect(latest.records[0]).toMatchObject({ status: "completed", exitedAt: "2026-10-21T00:01:00Z" })
})

it("discovers new owned records after transcript tool identity changes and after reconnect", async () => {
  const current = view()
  await render(current)
  records = [terminal, { ...terminal, id: "new" }]
  await render({ ...current, parts: [openPart("new")] })
  expect(latest.records.map((record) => record.id)).toEqual(["terminal-1", "new"])
  records = [{ ...terminal, status: "completed" }]
  await render({ ...current, syncStatus: "reconnecting" })
  await render(current)
  expect(latest.records[0]?.status).toBe("completed")
  expect(onEvent).toHaveBeenCalledTimes(1)
})

it.each(["Shell", "BackgroundShellCreate"])(
  "discovers a new owned terminal created through %s after the initial empty list",
  async (toolName) => {
    records = []
    await render()
    expect(latest.records).toEqual([])
    records = [terminal]
    const current = view()
    current.parts = [openPart(terminal.id, { toolName })]
    await render(current)
    expect(latest.records.map((record) => record.id)).toEqual(["terminal-1"])
    const queries = list.mock.calls.length
    await render({ ...current, parts: [{ ...current.parts[0]!, updatedAt: 99 }] })
    expect(list).toHaveBeenCalledTimes(queries)
  }
)

it("discovers an owned terminal while its native creation tool is still running", async () => {
  vi.useFakeTimers()
  records = []
  const current = view()
  current.parts = [
    openPart(terminal.id, { toolName: "Shell", status: "running", output: undefined }),
  ]
  await render(current)
  expect(latest.records).toEqual([])
  records = [terminal]
  await act(async () => vi.advanceTimersByTime(10_000))
  expect(latest.records.map((record) => record.id)).toEqual(["terminal-1"])
})

it("does not read workspace terminals without a session and cleans up its listener", async () => {
  await render(null)
  expect(list).not.toHaveBeenCalled()
  expect(latest).toEqual({ records: [], loading: false, error: null })
  await render()
  await render(null)
  expect(latest.records).toEqual([])
  await act(async () => root.unmount())
  expect(listeners.size).toBe(0)
  root = createRoot(container)
})

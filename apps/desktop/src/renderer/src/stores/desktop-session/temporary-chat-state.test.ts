// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { selectArchivedSessions, selectSessions } from "./selectors"
import { saveActivityPersistence } from "./activity-persistence"
import { createActivityState } from "./activity-state"
import { emptySessionView, resetDesktopSessionStore } from "./store-test-fixtures"
import { useDesktopSessionStore } from "./store"

beforeEach(() => {
  resetDesktopSessionStore()
  localStorage.clear()
})
afterEach(() => vi.unstubAllGlobals())

it("omits temporary records from sidebar lists while retaining ordinary forks", () => {
  const ordinary = { ...emptySessionView("ordinary").session, parentId: "main" }
  const temporary = { ...emptySessionView("temporary").session, storage: "memory" as const }
  useDesktopSessionStore.setState({ sessions: [ordinary, temporary], archivedSessions: [ordinary, temporary] })
  const state = useDesktopSessionStore.getState()
  expect(selectSessions(state)).toEqual([ordinary])
  expect(selectArchivedSessions(state)).toEqual([ordinary])
  expect(selectSessions(state)).toBe(selectSessions(state))
})

it("does not persist temporary activity read state", () => {
  const state = createActivityState()
  state.readSeqBySessionId = { ordinary: 2, temporary: 3 }
  state.sessions.temporary = {
    session: { ...emptySessionView("temporary").session, storage: "memory" },
    executionState: "completed", attentionState: "read", activitySeq: 3, updatedAt: 3,
  }
  saveActivityPersistence(state)
  expect(JSON.parse(localStorage.getItem("vykor.desktop.activity.v1")!).readSeqBySessionId)
    .toEqual({ ordinary: 2 })
})

it("does not save a temporary active session for restart restoration", () => {
  const view = emptySessionView("temporary")
  view.session.storage = "memory"
  useDesktopSessionStore.setState({ activeSessionId: "temporary", sessionView: null })
  useDesktopSessionStore.getState().applySessionUpdate(view)
  expect(localStorage.getItem("vykor.desktop.active-session.v1")).toBeNull()
})

it("opening a temporary fork does not save its active session ID", async () => {
  const view = emptySessionView("temporary")
  view.session.storage = "memory"
  vi.stubGlobal("window", { desktop: { sessions: { open: async () => view, close: async () => {} } } })
  await useDesktopSessionStore.getState().openSession("temporary")
  expect(useDesktopSessionStore.getState().sessionView?.session.id).toBe("temporary")
  expect(localStorage.getItem("vykor.desktop.active-session.v1")).toBeNull()
})

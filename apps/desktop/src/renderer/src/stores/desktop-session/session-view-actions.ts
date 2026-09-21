import {
  isPlaceholderTitle,
  sessionEffort,
  sessionPermissionMode,
  sessionProvider,
  upsertSession,
} from "./helpers"

import { createEmptySessionRuntime } from "./operation-state"

import { clearPersistedActiveSessionId, writePersistedActiveSessionId } from "./persistence"

import { acceptActiveSessionView, reconcileRuntimeWithView } from "./session-view-state"

import type { DesktopSessionState, DesktopStoreContext } from "./types"

import type { DesktopSessionRun, DesktopSessionView } from "@shared/session-types"

interface SessionViewActionsContext extends DesktopStoreContext {
  scheduleSelectedProjectGitRefresh: (force: boolean) => void
}

export function createApplySessionUpdate(
  context: SessionViewActionsContext
): DesktopSessionState["applySessionUpdate"] {
  const { get, set } = context

  return (view) => {
    const current = get().sessionView

    if (acceptActiveSessionView(get().activeSessionId, current, view) !== view) return

    if (view.session.status === "archived") clearPersistedActiveSessionId()
    else writePersistedActiveSessionId(view.session.id)

    const shouldRefreshContextUsage = didActiveRunFinish(current, view)

    set((state) => {
      const knownSession = state.sessions.find((session) => session.id === view.session.id)

      const session =
        knownSession &&
        isPlaceholderTitle(view.session.title) &&
        !isPlaceholderTitle(knownSession.title)
          ? { ...view.session, title: knownSession.title }
          : view.session

      const runtime = reconcileRuntimeWithView(
        state.sessionRuntimes[view.session.id] ?? createEmptySessionRuntime(),

        view
      )

      return {
        sessionView: { ...view, session },

        sessionRuntimes: { ...state.sessionRuntimes, [view.session.id]: runtime },

        selectedModel: session.model,

        selectedProvider: sessionProvider(session, state.defaultProvider),

        selectedPermissionMode: sessionPermissionMode(session, state.defaultPermissionMode),

        selectedEffort: sessionEffort(session),

        sessions:
          session.status === "archived"
            ? state.sessions.filter((item) => item.id !== session.id)
            : upsertSession(state.sessions, session),

        archivedSessions:
          session.status === "archived"
            ? upsertSession(state.archivedSessions, session)
            : state.archivedSessions,
      }
    })

    context.scheduleSelectedProjectGitRefresh(true)

    if (shouldRefreshContextUsage) {
      void get().refreshContextUsage({ refresh: true })
    }
  }
}

export function didActiveRunFinish(
  previous: DesktopSessionView | null,

  next: DesktopSessionView
): boolean {
  if (!previous) return false

  const previousRuns = new Map(previous.runs.map((run) => [run.id, run]))

  return next.runs.some((run) => {
    const prior = previousRuns.get(run.id)

    return Boolean(prior && isActiveRun(prior) && isTerminalRun(run))
  })
}

function isActiveRun(run: DesktopSessionRun): boolean {
  return run.status === "pending" || run.status === "running"
}

function isTerminalRun(run: DesktopSessionRun): boolean {
  return run.status === "completed" || run.status === "failed" || run.status === "interrupted"
}

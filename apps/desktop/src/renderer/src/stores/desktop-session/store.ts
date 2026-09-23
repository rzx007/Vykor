import { create } from "zustand"
import type { DesktopActivityUpdate } from "@shared/activity-types"

import { applyActivityUpdate as reduceActivity, markSessionRead } from "./activity-state"
import { saveActivityPersistence } from "./activity-persistence"
import { clearPersistedActiveSessionId } from "./persistence"
import { isTopLevelSession, upsertSession } from "./helpers"
import { createAttachmentActions } from "./attachment-actions"
import { attachDesktopDaemonStatusEvents, createBootstrapActions } from "./bootstrap-actions"
import { createInitialState } from "./initial-state"
import { createProjectActions } from "./project-actions"
import { createProjectDetailsCoordinator } from "./project-details-coordinator"
import { createSelectedProjectGitRefreshScheduler } from "./project-git-scheduler"
import { createPromptActions } from "./prompt-actions"
import { createQueuedPromptActions } from "./queued-prompt-actions"
import { createSessionActions } from "./session-actions"
import { createGoalActions } from "./goal-actions"
import { createApplySessionUpdate } from "./session-view-actions"
import type { DesktopSessionState } from "./types"

const selectedProjectGitRefreshScheduler = createSelectedProjectGitRefreshScheduler(
  (options) => useDesktopSessionStore.getState().refreshSelectedProjectGit(options),
  750
)
let desktopSessionEventSubscriptionCount = 0
let detachDesktopSessionUpdates: (() => void) | null = null
let detachDesktopDaemonStatus: (() => void) | null = null
let detachDesktopAttachmentUploads: (() => void) | null = null
let detachDesktopActivity: (() => void) | null = null
let activityAttachGeneration = 0
const projectDetailsCoordinator = createProjectDetailsCoordinator()

export const useDesktopSessionStore = create<DesktopSessionState>((set, get) => {
  const context = {
    set,
    get,
    projectDetailsCoordinator,
    scheduleSelectedProjectGitRefresh: selectedProjectGitRefreshScheduler.schedule,
  }

  return {
    ...createInitialState(),
    ...createBootstrapActions(context),
    ...createProjectActions(context),
    ...createSessionActions(context),
    ...createGoalActions(context),
    ...createPromptActions(context),
    ...createAttachmentActions(context),
    ...createQueuedPromptActions(context),
    applySessionUpdate: createApplySessionUpdate(context),
    applyActivityUpdate: (update: DesktopActivityUpdate) => {
      const previous = get().activity
      const removedSessions = new Set(update.removedSessionIds ?? [])
      const activeDeleted =
        get().activeSessionId !== null && removedSessions.has(get().activeSessionId!)
      const viewedSessionId =
        get().sessionView?.session.id === get().activeSessionId ? get().activeSessionId : null
      const { state: activity, notifications } = reduceActivity(previous, update, viewedSessionId)
      if (activity === previous) return
      const acceptedSessions = update.sessions.flatMap((item) => {
        const session = activity.sessions[item.session.id]?.session
        return session && isTopLevelSession(session) ? [session] : []
      })
      set((current) => ({
        activity,
        sessions: acceptedSessions
          .reduce(
            (sessions, session) =>
              session.status === "archived"
                ? sessions.filter((row) => row.id !== session.id)
                : upsertSession(sessions, session),
            current.sessions
          )
          .filter((item) => !removedSessions.has(item.id)),
        archivedSessions: acceptedSessions
          .reduce(
            (sessions, session) =>
              session.status === "archived" ? upsertSession(sessions, session) : sessions,
            current.archivedSessions
          )
          .filter((item) => !removedSessions.has(item.id)),
        activeSessionId: activeDeleted ? null : current.activeSessionId,
        sessionView: activeDeleted ? null : current.sessionView,
      }))
      if (activeDeleted) clearPersistedActiveSessionId()
      saveActivityPersistence(activity)
      for (const notification of notifications) {
        if (notification.taskId && notification.taskId === get().selectedScheduledTaskId) continue
        void window.desktop.settings
          .snapshot()
          .then((settings) => {
            if (settings.notificationMode === "never") return
            return window.desktop.tray.notify({
              title: notification.title,
              body: notification.body,
              ...(settings.notificationMode === "always" ? { showWhenFocused: true } : {}),
            })
          })
          .catch(() => undefined)
      }
    },
    markActivitySessionRead: (sessionId) => {
      const activity = markSessionRead(get().activity, sessionId)
      set({ activity })
      saveActivityPersistence(activity)
    },
  }
})

export function attachDesktopSessionEvents(): () => void {
  if (desktopSessionEventSubscriptionCount === 0) {
    detachDesktopDaemonStatus = attachDesktopDaemonStatusEvents({
      set: useDesktopSessionStore.setState,
      get: useDesktopSessionStore.getState,
      projectDetailsCoordinator,
    })
    detachDesktopSessionUpdates = window.desktop.sessions.onUpdated((view) => {
      useDesktopSessionStore.getState().applySessionUpdate(view)
      void useDesktopSessionStore.getState().refreshGoal(view.session.id)
    })
    if (typeof window.desktop.activity?.onUpdated === "function") {
      const generation = ++activityAttachGeneration
      detachDesktopActivity = window.desktop.activity.onUpdated((update) => {
        useDesktopSessionStore.getState().applyActivityUpdate(update)
      })
      void window.desktop.activity
        .open()
        .then((baseline) => {
          if (generation === activityAttachGeneration) {
            useDesktopSessionStore.getState().applyActivityUpdate(baseline)
          }
        })
        .catch(() => undefined)
    }
    if (typeof window.desktop.attachments?.onUploadEvent === "function") {
      detachDesktopAttachmentUploads = window.desktop.attachments.onUploadEvent((event) => {
        useDesktopSessionStore.getState().applyAttachmentUploadEvent(event)
      })
    }
    const activeSessionId = useDesktopSessionStore.getState().activeSessionId
    if (activeSessionId && typeof window.desktop.sessions.open === "function") {
      void useDesktopSessionStore.getState().resyncActiveSessionSnapshot()
    }
  }
  desktopSessionEventSubscriptionCount += 1

  let cleanedUp = false
  return () => {
    if (cleanedUp) return
    cleanedUp = true
    desktopSessionEventSubscriptionCount -= 1
    if (desktopSessionEventSubscriptionCount > 0) return

    detachDesktopSessionUpdates?.()
    detachDesktopDaemonStatus?.()
    detachDesktopAttachmentUploads?.()
    detachDesktopActivity?.()
    activityAttachGeneration += 1
    detachDesktopSessionUpdates = null
    detachDesktopDaemonStatus = null
    detachDesktopAttachmentUploads = null
    detachDesktopActivity = null
    selectedProjectGitRefreshScheduler.reset()
  }
}

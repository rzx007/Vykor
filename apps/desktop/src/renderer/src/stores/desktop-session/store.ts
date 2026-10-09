import { create } from "zustand"
import type { DesktopActivityUpdate } from "@shared/activity-types"
import { playNotificationSound } from "@renderer/lib/notification-sound"
import { normalizeNotificationSounds } from "@shared/settings-types"

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
import { createGoalRefreshScheduler } from "./goal-refresh-scheduler"
import { createPromptActions } from "./prompt-actions"
import { createQueuedPromptActions } from "./queued-prompt-actions"
import { createSessionActions } from "./session-actions"
import { createGoalActions } from "./goal-actions"
import { createApplySessionUpdate } from "./session-view-actions"
import { applySessionPartDeltas } from "./session-view-state"
import { createSessionUpdateDeliveryAcknowledger } from "./session-update-delivery"
import type { DesktopSessionState } from "./types"
import type { DesktopSessionUpdate } from "@shared/session-types"

const selectedProjectGitRefreshScheduler = createSelectedProjectGitRefreshScheduler(
  (options) => useDesktopSessionStore.getState().refreshSelectedProjectGit(options),
  750
)
const goalRefreshScheduler = createGoalRefreshScheduler(
  (sessionId) => useDesktopSessionStore.getState().refreshGoal(sessionId),
  1_000
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
      const {
        state: activity,
        notifications,
        sounds,
      } = reduceActivity(previous, update, viewedSessionId)
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
      if (sounds.length || notifications.length) {
        void window.desktop.settings
          .snapshot()
          .then((settings) => {
            const selectedSounds = normalizeNotificationSounds(settings.notificationSounds)
            for (const { status } of sounds) {
              if (status === "completed" || status === "needs_input" || status === "failed")
                void playNotificationSound(selectedSounds[status])
            }
            if (settings.notificationMode === "never") return
            return Promise.all(
              notifications.map((notification) => {
                return window.desktop.tray.notify({
                  title: notification.title,
                  body: notification.body,
                  silent: true,
                  ...(notification.status === "completed" || notification.status === "failed" || notification.status === "needs_input" ? { eventStatus: notification.status, eventId: notification.eventId } : {}),
                  ...(notification.sessionId ? { sessionId: notification.sessionId } : {}),
                  ...(settings.notificationMode === "always" ? { showWhenFocused: true } : {}),
                })
              })
            )
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
    const acknowledger = createSessionUpdateDeliveryAcknowledger(window.desktop.sessions)
    let activeSubscriptionId: string | null = null
    let activeGeneration = 0
    const unsubscribe = window.desktop.sessions.onUpdated((update: DesktopSessionUpdate) => {
      if (
        activeSubscriptionId !== null &&
        update.subscriptionId !== activeSubscriptionId &&
        update.generation < activeGeneration
      ) return
      if (
        activeSubscriptionId === update.subscriptionId &&
        update.generation < activeGeneration
      ) return
      if (
        activeSubscriptionId === update.subscriptionId &&
        update.generation > activeGeneration &&
        update.kind !== "snapshot"
      ) {
        acknowledger.acknowledge(update, "resync-required")
        return
      }

      if (update.kind === "snapshot") {
        activeSubscriptionId = update.subscriptionId
        activeGeneration = update.generation
        useDesktopSessionStore.getState().applySessionUpdate(update.view)
        goalRefreshScheduler.schedule(update.view.session.id)
        acknowledger.acknowledge(update, "applied")
        return
      }

      const state = useDesktopSessionStore.getState()
      if (
        state.activeSessionId !== update.sessionId ||
        state.sessionView?.session.id !== update.sessionId
      ) {
        acknowledger.acknowledge(update, "resync-required")
        return
      }
      const result = applySessionPartDeltas(state.sessionView, update)
      if (result.kind === "resync-required") {
        acknowledger.acknowledge(update, "resync-required")
        return
      }
      activeSubscriptionId = update.subscriptionId
      activeGeneration = update.generation
      useDesktopSessionStore.setState({ sessionView: result.view })
      acknowledger.acknowledge(update, "applied")
    })
    detachDesktopSessionUpdates = () => {
      unsubscribe()
      acknowledger.dispose()
    }
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
    goalRefreshScheduler.reset()
  }
}

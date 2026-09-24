import type {
  DesktopActivityUpdate,
  DesktopSessionActivity,
  DesktopScheduledActivity,
} from "@shared/activity-types"

export interface ActivityState {
  cursor: number

  initialized: boolean
  firstStartup: boolean

  sessions: Record<string, DesktopSessionActivity>

  scheduledRuns: Record<string, DesktopScheduledActivity>
  deletedTaskSeqById: Record<string, number>
  deletedSessionSeqById: Record<string, number>
  lastDeletedTaskId?: string

  readSeqBySessionId: Record<string, number>

  lastObservedCursor: number

  lastNotifiedCursor: number
}

export interface ActivityNotification {
  seq: number

  sessionId?: string

  taskId?: string

  status: DesktopSessionActivity["executionState"]

  title: string

  body: string
}

export function createActivityState(
  persisted?: Partial<
    Pick<ActivityState, "lastObservedCursor" | "lastNotifiedCursor" | "readSeqBySessionId">
  >
): ActivityState {
  return {
    cursor: 0,
    initialized: false,
    firstStartup:
      (persisted?.lastObservedCursor ?? 0) === 0 &&
      Object.keys(persisted?.readSeqBySessionId ?? {}).length === 0,
    sessions: {},
    scheduledRuns: {},
    deletedTaskSeqById: {},
    deletedSessionSeqById: {},

    readSeqBySessionId: persisted?.readSeqBySessionId ?? {},

    lastObservedCursor: persisted?.lastObservedCursor ?? 0,

    lastNotifiedCursor: persisted?.lastNotifiedCursor ?? 0,
  }
}

export function markSessionRead(state: ActivityState, sessionId: string): ActivityState {
  const activity = state.sessions[sessionId]

  if (!activity) return state

  return {
    ...state,

    readSeqBySessionId: {
      ...state.readSeqBySessionId,

      [sessionId]: Math.max(state.readSeqBySessionId[sessionId] ?? 0, activity.activitySeq),
    },

    sessions: { ...state.sessions, [sessionId]: { ...activity, attentionState: "read" } },
  }
}

export function forgetSessionActivity(
  state: ActivityState,
  deleted: ReadonlySet<string>
): ActivityState {
  return {
    ...state,
    sessions: Object.fromEntries(Object.entries(state.sessions).filter(([id]) => !deleted.has(id))),
    readSeqBySessionId: Object.fromEntries(
      Object.entries(state.readSeqBySessionId).filter(([id]) => !deleted.has(id))
    ),
  }
}

function isResult(state: DesktopSessionActivity["executionState"]): boolean {
  return (
    state === "completed" ||
    state === "failed" ||
    state === "interrupted" ||
    state === "needs_input"
  )
}

function sessionNotice(activity: DesktopSessionActivity): ActivityNotification {
  const status = activity.executionState

  const suffix =
    status === "needs_input"
      ? "正在等待处理。"
      : status === "completed"
        ? "已完成。"
        : status === "interrupted"
          ? "已中断。"
          : "运行失败。"

  return {
    seq: activity.activitySeq,
    sessionId: activity.session.id,
    status,

    title: status === "needs_input" ? "Vykor 需要处理" : "Vykor",

    body: `${activity.session.title.trim() || "当前任务"} ${suffix}`,
  }
}

export function applyActivityUpdate(
  state: ActivityState,
  update: DesktopActivityUpdate,
  activeSessionId: string | null
): { state: ActivityState; notifications: ActivityNotification[] } {
  const mergeFirstBaseline =
    update.delivery === "baseline" && !state.initialized && update.cursor <= state.cursor
  if (update.cursor < state.cursor && !mergeFirstBaseline) {
    return { state, notifications: [] }
  }

  if (state.initialized && update.cursor === state.cursor && update.delivery !== "baseline") {
    return { state, notifications: [] }
  }

  const firstBaseline = update.delivery === "baseline" && !state.initialized && state.firstStartup

  const sessions =
    update.delivery === "baseline" && !mergeFirstBaseline
      ? ({} as ActivityState["sessions"])
      : { ...state.sessions }

  const scheduledRuns =
    update.delivery === "baseline" && !mergeFirstBaseline
      ? ({} as ActivityState["scheduledRuns"])
      : { ...state.scheduledRuns }
  const deletedTaskSeqById = { ...state.deletedTaskSeqById }
  if (update.removedTaskId) {
    deletedTaskSeqById[update.removedTaskId] = update.cursor
    for (const [runId, item] of Object.entries(scheduledRuns)) {
      if (item.taskId === update.removedTaskId) delete scheduledRuns[runId]
    }
  }

  const readSeqBySessionId = { ...state.readSeqBySessionId }
  const deletedSessionSeqById = { ...state.deletedSessionSeqById }
  for (const id of update.removedSessionIds ?? []) {
    deletedSessionSeqById[id] = update.cursor
    delete sessions[id]
    delete readSeqBySessionId[id]
  }

  const notifications: ActivityNotification[] = []

  for (const activity of update.sessions) {
    const id = activity.session.id
    if ((deletedSessionSeqById[id] ?? 0) > update.cursor) continue
    if (mergeFirstBaseline && sessions[id]) continue

    const previous = sessions[id]

    const active = id === activeSessionId

    const significant =
      isResult(activity.executionState) ||
      (update.delivery === "baseline" && activity.activitySeq > 0) ||
      (update.eventType === "session.message.created" &&
        Boolean(activity.session.metadata["externalConversation"]))

    if (firstBaseline || active || (!previous && !significant && update.delivery !== "baseline")) {
      readSeqBySessionId[id] = Math.max(readSeqBySessionId[id] ?? 0, activity.activitySeq)
    }

    const unread =
      (significant || previous?.attentionState === "unread") &&
      !active &&
      activity.activitySeq > (readSeqBySessionId[id] ?? 0)

    sessions[id] = { ...activity, attentionState: unread ? "unread" : "read" }

    const transition =
      !previous ||
      previous.executionState !== activity.executionState ||
      previous.permissionId !== activity.permissionId

    if (
      update.delivery === "live" &&
      transition &&
      !active &&
      !activity.session.metadata["scheduledTask"] &&
      isResult(activity.executionState) &&
      activity.activitySeq > state.lastNotifiedCursor &&
      (activity.executionState === "needs_input" || previous?.executionState === "running")
    ) {
      notifications.push(sessionNotice(activity))
    }
  }

  for (const activity of update.scheduled) {
    if ((deletedTaskSeqById[activity.taskId] ?? 0) > activity.activitySeq) continue
    if (mergeFirstBaseline && scheduledRuns[activity.run.id]) continue
    const previous = scheduledRuns[activity.run.id]

    scheduledRuns[activity.run.id] = {
      ...activity,
      attentionState: activity.run.unread ? "unread" : "read",
    }

    if (
      update.delivery === "live" &&
      activity.run.unread &&
      (!previous || previous.executionState !== activity.executionState) &&
      isResult(activity.executionState) &&
      activity.activitySeq > state.lastNotifiedCursor
    ) {
      notifications.push({
        seq: activity.activitySeq,
        taskId: activity.taskId,
        status: activity.executionState,

        title: "Vykor 定时任务",

        body: `定时任务${activity.executionState === "completed" ? "已完成" : "需要处理"}。`,
      })
    }
  }

  return {
    state: {
      ...state,

      cursor: Math.max(state.cursor, update.cursor),

      initialized: state.initialized || update.delivery === "baseline",

      sessions,
      scheduledRuns,
      deletedTaskSeqById,
      deletedSessionSeqById,
      lastDeletedTaskId: update.removedTaskId ?? state.lastDeletedTaskId,
      readSeqBySessionId,

      lastObservedCursor: Math.max(state.lastObservedCursor, update.cursor),

      lastNotifiedCursor: Math.max(
        state.lastNotifiedCursor,
        ...notifications.map(({ seq }) => seq)
      ),
    },

    notifications,
  }
}

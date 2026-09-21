import {
  applyEvent,
  type OpenHarnessClientState,
  type SessionEventRecord,
} from "@openharness/client"

const projectedTypes = new Set([
  "session.created",
  "session.updated",
  "session.archived",
  "session.deleted",
  "session.run.created",
  "session.run.updated",
  "permission.asked",
  "permission.replied",
])

export function reduceActivityEvent(
  state: OpenHarnessClientState,
  event: SessionEventRecord
): OpenHarnessClientState {
  if (event.seq <= state.lastSeq) return state
  if (event.type === "session.message.created") {
    const id = event.sessionId
    const current = id ? state.buckets[id]?.session : undefined
    if (!id || !current) return { ...state, lastSeq: event.seq }
    const session = { ...current, updatedAt: Math.max(current.updatedAt, event.createdAt) }
    const sessions = { ...state.sessions, [id]: session }
    return {
      ...state,
      lastSeq: event.seq,
      sessions,
      sessionOrder: Object.values(sessions)
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .map((item) => item.id),
      buckets: { ...state.buckets, [id]: { ...state.buckets[id]!, session } },
    }
  }
  if (!projectedTypes.has(event.type)) return { ...state, lastSeq: event.seq }
  const next = applyEvent({ ...state, eventsBySeq: {} }, event)
  const id = event.sessionId
  if (!id || !next.buckets[id]) return { ...next, eventsBySeq: {} }
  const bucket = next.buckets[id]!
  const permissions = Object.fromEntries(
    Object.entries(bucket.permissions).filter(([, item]) => item.status === "pending")
  )
  return {
    ...next,
    eventsBySeq: {},
    buckets: { ...next.buckets, [id]: { ...bucket, permissions } },
  }
}

import type { WebContents } from "electron"
import {
  syncEvents,
  type ScheduledRunRecord,
  type SessionEventRecord,
  type SyncEventUpdate,
} from "@vykor/client"
import type {
  DesktopActivityUpdate,
  DesktopScheduledActivity,
  DesktopSessionActivity,
} from "../../../shared/activity-types"
import { IpcEvents } from "../../../shared/ipc-channels"
import { projectScheduledActivity, projectSessionActivity } from "./activity-projection"
import { reduceActivityEvent } from "./activity-reducer"
import { toDesktopSessionRecord } from "../session/session-subscription-service"
import { pumpSubscription } from "../session/session-subscription-pump"

type ActivityClient = Parameters<typeof syncEvents>[0]
type CreateIterator = (
  client: ActivityClient,
  signal: AbortSignal
) => AsyncIterator<SyncEventUpdate>

interface Subscription {
  webContents: WebContents
  onDestroyed: () => void
  controller: AbortController
  generation: number
  snapshot: DesktopActivityUpdate | null
  sessions: Map<string, DesktopSessionActivity>
  scheduled: Map<string, DesktopScheduledActivity>
  deletedSessionIds: Set<string>
  cursor: number
  baselineReady: Promise<DesktopActivityUpdate>
  rejectBaseline: (error: unknown) => void
}

const defaultCreateIterator: CreateIterator = (client, signal) =>
  syncEvents(client, { signal, globalReducer: reduceActivityEvent })[Symbol.asyncIterator]()

export class GlobalActivitySubscriptionService {
  private readonly owners = new Map<number, Subscription>()
  private nextGeneration = 0

  constructor(
    private readonly createIterator: CreateIterator = defaultCreateIterator,
    private readonly onSessionsDeleted?: (
      webContentsId: number,
      sessionIds: readonly string[]
    ) => void
  ) {}

  hasOwner(id: number): boolean {
    return this.owners.has(id)
  }

  open(client: ActivityClient, webContents: WebContents): Promise<DesktopActivityUpdate> {
    const existing = this.owners.get(webContents.id)
    if (existing) {
      return existing.snapshot
        ? Promise.resolve(this.fullBaseline(existing))
        : existing.baselineReady
    }

    const controller = new AbortController()
    let resolveBaseline!: (value: DesktopActivityUpdate) => void
    let rejectBaseline!: (error: unknown) => void
    const baselineReady = new Promise<DesktopActivityUpdate>((resolve, reject) => {
      resolveBaseline = resolve
      rejectBaseline = reject
    })
    const subscription: Subscription = {
      webContents,
      onDestroyed: () => this.close(webContents.id),
      controller,
      generation: ++this.nextGeneration,
      snapshot: null,
      sessions: new Map(),
      scheduled: new Map(),
      deletedSessionIds: new Set(),
      cursor: 0,
      baselineReady,
      rejectBaseline,
    }
    this.owners.set(webContents.id, subscription)
    webContents.once("destroyed", subscription.onDestroyed)
    void this.consume(client, subscription, resolveBaseline)
    return baselineReady
  }

  close(id: number): void {
    const subscription = this.owners.get(id)
    if (!subscription) return
    this.owners.delete(id)
    subscription.webContents.removeListener("destroyed", subscription.onDestroyed)
    subscription.controller.abort()
    if (!subscription.snapshot)
      subscription.rejectBaseline(new Error("Activity subscription closed"))
  }

  clearAll(): void {
    for (const id of this.owners.keys()) this.close(id)
  }

  async replaceClient(client: ActivityClient): Promise<void> {
    const webContents = [...this.owners.values()].map((owner) => owner.webContents)
    this.clearAll()
    await Promise.all(
      webContents
        .filter((owner) => !owner.isDestroyed())
        .map(async (owner) => {
          const baseline = await this.open(client, owner)
          if (!owner.isDestroyed()) owner.send(IpcEvents.activityUpdated, baseline)
        })
    )
  }

  private async consume(
    client: ActivityClient,
    subscription: Subscription,
    resolveBaseline: (value: DesktopActivityUpdate) => void
  ): Promise<void> {
    const isCurrent = (): boolean =>
      !subscription.controller.signal.aborted &&
      !subscription.webContents.isDestroyed() &&
      this.owners.get(subscription.webContents.id)?.generation === subscription.generation
    await pumpSubscription<SyncEventUpdate>({
      createIterator: () => this.createIterator(client, subscription.controller.signal),
      isActive: isCurrent,
      onUpdate: (value) => {
        const update = this.project(subscription, value)
        if (!update) return
        if (update.delivery === "baseline") {
          const first = subscription.snapshot === null
          subscription.snapshot = update
          if (first) resolveBaseline(update)
          else subscription.webContents.send(IpcEvents.activityUpdated, update)
        } else if (subscription.snapshot) {
          subscription.webContents.send(IpcEvents.activityUpdated, update)
        }
      },
      onReconnecting: () => {
        if (!subscription.snapshot) return
        subscription.webContents.send(IpcEvents.activityUpdated, {
          cursor: subscription.cursor,
          delivery: "reconnecting",
          sessions: [],
          scheduled: [],
        } satisfies DesktopActivityUpdate)
      },
    })
  }

  private project(
    subscription: Subscription,
    update: SyncEventUpdate
  ): DesktopActivityUpdate | null {
    if (update.source === "snapshot") {
      return this.fullBaseline(subscription, update.state.lastSeq)
    }
    if (update.source === "reconnecting") {
      return { cursor: subscription.cursor, delivery: "reconnecting", sessions: [], scheduled: [] }
    }
    const event = update.event
    if (!event || event.seq <= subscription.cursor) return null
    subscription.cursor = event.seq
    const sessions: DesktopSessionActivity[] = []
    const scheduled: DesktopScheduledActivity[] = []
    const removedSessionIds =
      event.type === "session.deleted" && Array.isArray(event.payload.sessionIds)
        ? event.payload.sessionIds.filter((id): id is string => typeof id === "string")
        : []
    if (removedSessionIds.length > 0) {
      const deleted = new Set(removedSessionIds)
      for (const id of deleted) {
        subscription.sessions.delete(id)
        subscription.deletedSessionIds.add(id)
      }
      this.onSessionsDeleted?.(subscription.webContents.id, removedSessionIds)
      for (const [runId, item] of subscription.scheduled) {
        if (!item.run.sessionId || !deleted.has(item.run.sessionId)) continue
        const updated = projectScheduledActivity({ ...item.run, sessionId: undefined }, event.seq)
        subscription.scheduled.set(runId, updated)
        scheduled.push(updated)
      }
    }
    const removedTaskId =
      event.type === "scheduled.task.deleted" && typeof event.payload.taskId === "string"
        ? event.payload.taskId
        : undefined
    if (removedTaskId) {
      for (const [runId, item] of subscription.scheduled) {
        if (item.taskId === removedTaskId) subscription.scheduled.delete(runId)
      }
    }
    const run = readScheduledRun(event)
    if (run) {
      const item = projectScheduledActivity(run, event.seq)
      subscription.scheduled.set(run.id, item)
      scheduled.push(item)
    } else {
      const sessionId = event.sessionId ?? readSessionId(event)
      if (sessionId && shouldProjectSession(event.type)) {
        const previous = subscription.sessions.get(sessionId)
        const activitySeq = isAttentionEvent(event) ? event.seq : (previous?.activitySeq ?? 0)
        const item = projectSessionActivity(update.state, sessionId, activitySeq)
        if (item) {
          if (event.type === "session.created") subscription.deletedSessionIds.delete(sessionId)
          item.session = toDesktopSessionRecord(item.session)
          subscription.sessions.set(sessionId, item)
          sessions.push(item)
        }
      }
    }
    if (!subscription.snapshot) return null
    if (
      sessions.length === 0 &&
      scheduled.length === 0 &&
      !removedTaskId &&
      removedSessionIds.length === 0
    )
      return null
    return {
      cursor: event.seq,
      delivery: update.source === "live" ? "live" : "catchup",
      sessions,
      scheduled,
      eventType: event.type,
      ...(removedTaskId ? { removedTaskId } : {}),
      ...(removedSessionIds.length > 0 ? { removedSessionIds } : {}),
      ...(typeof event.payload.previousStatus === "string" && {
        previousStatus: event.payload.previousStatus,
      }),
    }
  }

  private fullBaseline(
    subscription: Subscription,
    cursor = subscription.cursor
  ): DesktopActivityUpdate {
    return {
      cursor,
      delivery: "baseline",
      sessions: [...subscription.sessions.values()],
      scheduled: [...subscription.scheduled.values()],
      ...(subscription.deletedSessionIds.size > 0
        ? { removedSessionIds: [...subscription.deletedSessionIds] }
        : {}),
    }
  }
}

function readScheduledRun(event: SessionEventRecord): ScheduledRunRecord | undefined {
  if (event.type !== "scheduled.run.created" && event.type !== "scheduled.run.updated")
    return undefined
  const run = event.payload.run
  return run && typeof run === "object" && !Array.isArray(run)
    ? (run as ScheduledRunRecord)
    : undefined
}

function readSessionId(event: SessionEventRecord): string | undefined {
  const session = event.payload.session
  return session && typeof session === "object" && "id" in session && typeof session.id === "string"
    ? session.id
    : undefined
}

function shouldProjectSession(type: string): boolean {
  return (
    type === "session.created" ||
    type === "session.updated" ||
    type === "session.archived" ||
    type.startsWith("session.run.") ||
    type.startsWith("session.task.") ||
    type === "session.message.created" ||
    type.startsWith("permission.")
  )
}

function isAttentionEvent(event: SessionEventRecord): boolean {
  if (event.type === "permission.asked") return true
  if (event.type === "session.message.created") return true
  if (event.type !== "session.run.updated") return false
  const run = event.payload.run
  return Boolean(
    run &&
    typeof run === "object" &&
    "status" in run &&
    (run.status === "completed" || run.status === "failed" || run.status === "interrupted")
  )
}

import type { WebContents } from "electron"
import {
  syncEvents,
  type VykorClientState,
  type SessionAttachmentMessagePartRecord,
  type SessionMessagePartRecord,
  type SessionRecord,
  type SessionTransformationMessagePartRecord,
  type SyncEventUpdate,
} from "@vykor/client"

import { IpcEvents } from "../../../shared/ipc-channels"
import type {
  CloseDesktopAuxSessionInput,
  DesktopAuxSessionUpdate,
  DesktopSessionPart,
  DesktopSessionPartDelta,
  DesktopSessionRecord,
  DesktopSessionResyncRequest,
  DesktopSessionUpdate,
  DesktopSessionUpdateAck,
  DesktopSessionUpdateAckResult,
  DesktopSessionView,
  DesktopStandardSessionPart,
  OpenDesktopAuxSessionInput,
} from "../../../shared/session-types"
import { isOutsideProjectWorkspacePath } from "./outside-project-workspace"
import { pumpSubscription } from "./session-subscription-pump"
import { createSessionUpdateCoalescer } from "./session-update-coalescer"
import {
  reserveSubscriptionSnapshot,
  SessionSubscriptionRegistry,
  type SessionSubscription,
} from "./session-subscriptions"
import { app } from "electron"

const primarySubscriptionSlot = "primary"
const defaultSessionUpdateIntervalMs = 50
type SessionSubscriptionClient = Parameters<typeof syncEvents>[0]

export interface SessionSubscriptionServiceOptions {
  /** Coalescing window (ms) for session updates pushed to the renderer. */
  sessionUpdateIntervalMs?: number
}

function auxiliarySubscriptionSlot(subscriptionId: string): string {
  return `aux:${subscriptionId}`
}

interface LiveDeliveryState {
  ownerId: number
  slot: string
  sessionId: string
  webContents: WebContents
  subscription: SessionSubscription
  subscriptionId: string
  generation: number
  inFlight: DesktopSessionUpdate | null
  recentlyAckedDeliveryIds: Set<string>
  ackedDeliveryOrder: string[]
  pendingDeltas: DesktopSessionPartDelta[]
  pendingBytes: number
  pendingReady: boolean
  snapshotRequired: boolean
  latestState: VykorClientState | null
  requestSnapshot(): void
}

const maxPendingDeltas = 500
const maxPendingDeltaBytes = 1024 * 1024
// Covers more than the five-second watchdog window at the default 50 ms cadence.
const maxRememberedAcknowledgements = 128

export class SessionSubscriptionService {
  private readonly subscriptions = new SessionSubscriptionRegistry()
  private readonly liveDeliveries = new WeakMap<SessionSubscription, LiveDeliveryState>()
  private readonly invalidationListeners = new Set<(ownerId: number) => void>()
  private readonly primaryOwners = new Set<number>()
  private readonly snapshotListeners = new Set<(ownerId: number, view: DesktopSessionView) => void>()
  private readonly sessionUpdateIntervalMs: number
  private nextGeneration = 1
  private nextDeliveryId = 1
  private nextPrimarySubscriptionId = 1

  constructor(options: SessionSubscriptionServiceOptions = {}) {
    this.sessionUpdateIntervalMs = options.sessionUpdateIntervalMs ?? defaultSessionUpdateIntervalMs
  }

  hasPrimary(webContentsId: number, sessionId: string): boolean {
    const sub = this.subscriptions.get(webContentsId, primarySubscriptionSlot)
    return sub?.sessionId === sessionId
  }

  getOwnerSessionId(ownerId: number): string | undefined {
    const subscription = this.subscriptions.get(ownerId, primarySubscriptionSlot)
    return subscription && !subscription.controller.signal.aborted ? subscription.sessionId : undefined
  }

  onOwnerInvalidated(listener: (ownerId: number) => void): () => void {
    this.invalidationListeners.add(listener)
    return () => { this.invalidationListeners.delete(listener) }
  }
  onOwnerSnapshot(listener: (ownerId: number, view: DesktopSessionView) => void): () => void {
    this.snapshotListeners.add(listener)
    return () => { this.snapshotListeners.delete(listener) }
  }

  closeDeletedSessions(webContentsId: number, sessionIds: readonly string[]): void {
    if (sessionIds.includes(this.getOwnerSessionId(webContentsId) ?? ""))
      for (const listener of this.invalidationListeners) listener(webContentsId)
    this.subscriptions.deleteMatchingSessions(webContentsId, new Set(sessionIds))
  }

  closeSession(webContentsId: number): void {
    for (const listener of this.invalidationListeners) listener(webContentsId)
    this.primaryOwners.delete(webContentsId)
    this.subscriptions.clearOwner(webContentsId)
  }

  closeAuxSession(webContentsId: number, input: CloseDesktopAuxSessionInput): void {
    const subscriptionId = requireString(input.subscriptionId, "辅助订阅 ID")
    this.subscriptions.delete(webContentsId, auxiliarySubscriptionSlot(subscriptionId))
  }

  acknowledgeUpdate(
    ownerId: number,
    ack: DesktopSessionUpdateAck
  ): DesktopSessionUpdateAckResult {
    if (!isValidUpdateAck(ack)) return { accepted: false }
    const live = this.findLiveDelivery(ownerId, ack.subscriptionId)
    if (!live) return { accepted: false }
    const inFlight = live.inFlight
    if (
      !inFlight ||
      inFlight.generation !== ack.generation ||
      inFlight.deliveryId !== ack.deliveryId
    ) {
      return { accepted: false }
    }

    live.inFlight = null
    live.recentlyAckedDeliveryIds.add(ack.deliveryId)
    live.ackedDeliveryOrder.push(ack.deliveryId)
    if (live.ackedDeliveryOrder.length > maxRememberedAcknowledgements) {
      const expired = live.ackedDeliveryOrder.shift()
      if (expired) live.recentlyAckedDeliveryIds.delete(expired)
    }
    if (ack.result === "resync-required") {
      live.requestSnapshot()
    } else if (live.pendingReady) {
      this.deliverPending(live)
    }
    return { accepted: true }
  }

  requestUpdateResync(
    ownerId: number,
    request: DesktopSessionResyncRequest
  ): DesktopSessionUpdateAckResult {
    if (!isValidResyncRequest(request)) return { accepted: false }
    const live = this.findLiveDelivery(ownerId, request.subscriptionId)
    if (!live) return { accepted: false }
    if (live.recentlyAckedDeliveryIds.has(request.deliveryId)) return { accepted: true }
    if (
      live.generation !== request.generation ||
      live.inFlight?.deliveryId !== request.deliveryId
    ) {
      return { accepted: false }
    }

    live.requestSnapshot()
    return { accepted: true }
  }

  private findLiveDelivery(ownerId: number, subscriptionId: string): LiveDeliveryState | undefined {
    const primary = this.subscriptions.get(ownerId, primarySubscriptionSlot)
    const primaryDelivery = primary && this.liveDeliveries.get(primary)
    if (primaryDelivery?.subscriptionId === subscriptionId) return primaryDelivery

    const auxiliary = this.subscriptions.get(ownerId, auxiliarySubscriptionSlot(subscriptionId))
    const auxiliaryDelivery = auxiliary && this.liveDeliveries.get(auxiliary)
    return auxiliaryDelivery?.subscriptionId === subscriptionId ? auxiliaryDelivery : undefined
  }

  private deliverPending(live: LiveDeliveryState): void {
    if (live.snapshotRequired) {
      live.pendingReady = false
      live.pendingDeltas = []
      live.pendingBytes = 0
      live.snapshotRequired = false
      this.dispatchSnapshot(live, "reconnecting")
      return
    }
    if (live.pendingDeltas.length === 0) {
      live.pendingReady = false
      return
    }
    const deltas = live.pendingDeltas
    live.pendingDeltas = []
    live.pendingBytes = 0
    live.pendingReady = false
    this.dispatchUpdate(live, {
      kind: "part-delta",
      subscriptionId: live.subscriptionId,
      generation: live.generation,
      deliveryId: this.createDeliveryId(),
      sessionId: live.sessionId,
      deltas,
    })
  }

  private createDeliveryId(): string {
    return `delivery-${this.nextDeliveryId++}`
  }

  private dispatchSnapshot(
    live: LiveDeliveryState,
    source: SyncEventUpdate["source"]
  ): void {
    const state = live.latestState
    if (!state || !state.buckets[live.sessionId]?.session) return
    let view: DesktopSessionView
    try {
      view = toDesktopSessionView(state, live.sessionId, source)
    } catch (error) {
      console.error(`[session] failed to build recovery snapshot for ${live.sessionId}`, error)
      return
    }
    this.dispatchUpdate(live, {
      kind: "snapshot",
      subscriptionId: live.subscriptionId,
      generation: live.generation,
      deliveryId: this.createDeliveryId(),
      view,
    })
  }

  private dispatchUpdate(live: LiveDeliveryState, update: DesktopSessionUpdate): void {
    if (
      live.webContents.isDestroyed() ||
      !this.subscriptions.isCurrent(live.ownerId, live.slot, live.subscription)
    ) return
    live.inFlight = update
    try {
      if (live.slot === primarySubscriptionSlot) {
        live.webContents.send(IpcEvents.sessionUpdated, update)
      } else {
        const payload: DesktopAuxSessionUpdate = {
          subscriptionId: update.subscriptionId,
          update,
        }
        live.webContents.send(IpcEvents.sessionAuxUpdated, payload)
      }
    } catch (error) {
      live.inFlight = null
      live.snapshotRequired = true
      console.error(`[session] failed to send update for owner ${live.ownerId}`, error)
    }
  }

  clearAll(): void {
    for (const ownerId of this.primaryOwners)
      for (const listener of this.invalidationListeners) listener(ownerId)
    this.primaryOwners.clear()
    this.subscriptions.clearAll()
  }

  async openSession(
    client: SessionSubscriptionClient,
    webContents: WebContents,
    sessionIdInput: string
  ): Promise<DesktopSessionView> {
    const sessionId = requireString(sessionIdInput, "会话 ID")
    // Retire the primary view's UI bindings without closing auxiliary chats.
    for (const listener of this.invalidationListeners) listener(webContents.id)

    const controller = new AbortController()
    const subscriptionId = `primary:${this.nextPrimarySubscriptionId++}`
    const subscription = { controller, sessionId }
    this.primaryOwners.add(webContents.id)
    webContents.once("destroyed", () => this.closeSession(webContents.id))
    const { snapshot, iterator } = await reserveSubscriptionSnapshot(
      this.subscriptions,
      webContents.id,
      primarySubscriptionSlot,
      subscription,
      async () => {
        return syncEvents(client, {
          partView: "summary",
          sessionId,
          signal: controller.signal,
        })[Symbol.asyncIterator]()
      },
      "无法加载会话状态。"
    )

    setTimeout(() => {
      void this.pumpSession(
        client,
        webContents,
        primarySubscriptionSlot,
        sessionId,
        controller,
        iterator,
        subscriptionId
      )
    }, 0)

    const initialView = toDesktopSessionView(snapshot.state, sessionId, snapshot.source)
    for (const listener of this.snapshotListeners) listener(webContents.id, initialView)
    return initialView
  }

  async openAuxSession(
    client: SessionSubscriptionClient,
    webContents: WebContents,
    input: OpenDesktopAuxSessionInput
  ): Promise<DesktopSessionView> {
    const subscriptionId = requireString(input.subscriptionId, "辅助订阅 ID")
    const sessionId = requireString(input.sessionId, "会话 ID")
    const slot = auxiliarySubscriptionSlot(subscriptionId)
    const controller = new AbortController()
    const subscription = { controller, sessionId }
    const { snapshot, iterator } = await reserveSubscriptionSnapshot(
      this.subscriptions,
      webContents.id,
      slot,
      subscription,
      async () => {
        return syncEvents(client, {
          partView: "summary",
          sessionId,
          signal: controller.signal,
        })[Symbol.asyncIterator]()
      },
      "无法加载辅助会话状态。"
    )
    setTimeout(() => {
      void this.pumpSession(
        client,
        webContents,
        slot,
        sessionId,
        controller,
        iterator,
        subscriptionId
      )
    }, 0)
    return toDesktopSessionView(snapshot.state, sessionId, snapshot.source)
  }

  private async pumpSession(
    client: SessionSubscriptionClient,
    webContents: WebContents,
    slot: string,
    sessionId: string,
    controller: AbortController,
    iterator: AsyncIterator<SyncEventUpdate>,
    subscriptionId: string
  ): Promise<void> {
    const subscription = this.subscriptions.get(webContents.id, slot)
    if (!subscription || subscription.controller !== controller) return
    let windowDeltas: DesktopSessionPartDelta[] = []
    let windowBytes = 0
    let coalescer!: ReturnType<typeof createSessionUpdateCoalescer<VykorClientState, SyncEventUpdate["source"]>>
    const live: LiveDeliveryState = {
      ownerId: webContents.id,
      slot,
      sessionId,
      webContents,
      subscription,
      subscriptionId,
      generation: this.nextGeneration++,
      inFlight: null,
      recentlyAckedDeliveryIds: new Set(),
      ackedDeliveryOrder: [],
      pendingDeltas: [],
      pendingBytes: 0,
      pendingReady: false,
      snapshotRequired: false,
      latestState: null,
      requestSnapshot: () => undefined,
    }
    this.liveDeliveries.set(subscription, live)

    const clearDeltaBuffers = (): void => {
      windowDeltas = []
      windowBytes = 0
      live.pendingDeltas = []
      live.pendingBytes = 0
    }
    const requireSnapshot = (): void => {
      live.snapshotRequired = true
      clearDeltaBuffers()
    }
    live.requestSnapshot = () => {
      if (!live.latestState) return
      live.generation = this.nextGeneration++
      live.inFlight = null
      live.snapshotRequired = false
      live.pendingReady = false
      clearDeltaBuffers()
      coalescer.flushNow(live.latestState, "reconnecting")
    }

    coalescer = createSessionUpdateCoalescer<VykorClientState, SyncEventUpdate["source"]>({
      delayMs: this.sessionUpdateIntervalMs,
      deliver: (state, source) => {
        live.latestState = state
        if (!state.buckets[sessionId]?.session) return
        const deltas = windowDeltas
        const requiresSnapshotNow = live.snapshotRequired || source === "reconnecting"
        windowDeltas = []
        windowBytes = 0

        if (live.inFlight) {
          if (requiresSnapshotNow) {
            requireSnapshot()
          } else {
            live.pendingDeltas.push(...deltas)
            live.pendingBytes += deltas.reduce((total, delta) => total + deltaByteLength(delta), 0)
            if (
              live.pendingDeltas.length > maxPendingDeltas ||
              live.pendingBytes > maxPendingDeltaBytes
            ) {
              requireSnapshot()
            }
          }
          live.pendingReady = true
          return
        }

        if (requiresSnapshotNow || deltas.length === 0) {
          live.snapshotRequired = false
          clearDeltaBuffers()
          this.dispatchSnapshot(live, source)
          return
        }
        this.dispatchUpdate(live, {
          kind: "part-delta",
          subscriptionId,
          generation: live.generation,
          deliveryId: this.createDeliveryId(),
          sessionId,
          deltas,
        })
      },
    })

    try {
      await pumpSubscription<SyncEventUpdate>({
        initialIterator: iterator,
        createIterator: () =>
          syncEvents(client, { sessionId, signal: controller.signal, partView: "summary" })[Symbol.asyncIterator](),
        isActive: () =>
          !controller.signal.aborted &&
          !webContents.isDestroyed() &&
          Boolean(subscription) &&
          this.subscriptions.isCurrent(webContents.id, slot, subscription!),
        onUpdate: (update) => {
          if (!update.state.buckets[sessionId]?.session) {
            if (slot === primarySubscriptionSlot)
              for (const listener of this.invalidationListeners) listener(webContents.id)
            this.subscriptions.delete(webContents.id, slot)
            coalescer.dispose()
            return
          }
          live.latestState = update.state
          const delta = toDesktopSessionPartDelta(update, sessionId)
          if (delta && !live.snapshotRequired) {
            windowDeltas.push(delta)
            windowBytes += deltaByteLength(delta)
            if (
              windowDeltas.length + live.pendingDeltas.length > maxPendingDeltas ||
              windowBytes + live.pendingBytes > maxPendingDeltaBytes
            ) {
              requireSnapshot()
            }
          } else if (!delta) {
            requireSnapshot()
            if (slot === primarySubscriptionSlot)
              for (const listener of this.snapshotListeners)
                listener(webContents.id, toDesktopSessionView(update.state, sessionId, update.source))
          }
          if (update.source === "reconnecting") {
            requireSnapshot()
            coalescer.flushNow(update.state, "reconnecting")
            return
          }
          coalescer.queue(update.state, update.source)
        },
        onReconnecting: (last) => {
          if (slot === primarySubscriptionSlot)
            for (const listener of this.snapshotListeners) listener(webContents.id, toDesktopSessionView(last.state, sessionId, "reconnecting"))
          live.latestState = last.state
          requireSnapshot()
          coalescer.flushNow(last.state, "reconnecting")
        },
        onError: (error) => {
          if (!controller.signal.aborted && !webContents.isDestroyed()) {
            console.error(`[session] sync failed for ${sessionId}`, error)
          }
        },
      })
    } finally {
      coalescer.dispose()
      live.inFlight = null
      clearDeltaBuffers()
    }
  }
}

function toDesktopSessionPartDelta(
  update: SyncEventUpdate,
  sessionId: string
): DesktopSessionPartDelta | null {
  const event = update.event
  if (!event || event.type !== "session.message.part.delta") return null
  const payload = event.payload
  const eventSessionId = payload.sessionId
  const messageId = payload.messageId
  const partId = payload.partId
  const field = payload.field
  const delta = payload.delta
  if (
    (event.sessionId !== undefined && event.sessionId !== sessionId) ||
    (eventSessionId !== undefined && eventSessionId !== sessionId) ||
    typeof messageId !== "string" ||
    typeof partId !== "string" ||
    (field !== "text" && field !== "reasoning") ||
    typeof delta !== "string"
  ) return null
  const part = update.state.buckets[sessionId]?.partsByMessageId[messageId]?.find(
    (candidate) => candidate.id === partId
  )
  if (!part || typeof part.text !== "string") return null
  const baseLength = part.text.length - delta.length
  if (baseLength < 0) return null
  return {
    seq: event.seq,
    messageId,
    partId,
    field,
    delta,
    baseLength,
    partSeq: part.seq,
    createdAt: event.createdAt,
  }
}

function deltaByteLength(delta: DesktopSessionPartDelta): number {
  return Buffer.byteLength(JSON.stringify(delta), "utf8")
}

function isValidUpdateAck(value: DesktopSessionUpdateAck): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof value.subscriptionId === "string" &&
    value.subscriptionId.length > 0 &&
    Number.isSafeInteger(value.generation) &&
    typeof value.deliveryId === "string" &&
    value.deliveryId.length > 0 &&
    (value.result === "applied" || value.result === "resync-required")
  )
}

function isValidResyncRequest(value: DesktopSessionResyncRequest): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof value.subscriptionId === "string" &&
    value.subscriptionId.length > 0 &&
    Number.isSafeInteger(value.generation) &&
    typeof value.deliveryId === "string" &&
    value.deliveryId.length > 0 &&
    (value.lastAppliedDeliveryId === null || typeof value.lastAppliedDeliveryId === "string")
  )
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label}不能为空。`)
  return value.trim()
}

export function toDesktopSessionView(
  state: VykorClientState,
  sessionId: string,
  source: "snapshot" | "replay" | "live" | "reconnecting"
): DesktopSessionView {
  const bucket = state.buckets[sessionId]
  if (!bucket?.session) throw new Error(`会话 ${sessionId} 不存在。`)
  return {
    cursor: state.lastSeq,
    syncStatus: source === "reconnecting" ? "reconnecting" : "connected",
    session: toDesktopSessionRecord(bucket.session),
    inputs: [...bucket.inputs],
    messages: [...bucket.messages].sort((a, b) => a.seq - b.seq),
    parts: Object.values(bucket.partsByMessageId)
      .flat()
      .sort((a, b) => a.seq - b.seq)
      .map(toDesktopSessionPart),
    runs: Object.values(bucket.runs),
    tasks: Object.values(bucket.tasks),
    permissions: Object.values(bucket.permissions),
  }
}

function toDesktopSessionPart(part: SessionMessagePartRecord): DesktopSessionPart {
  if (part.type === "attachment") {
    return part as SessionAttachmentMessagePartRecord
  }
  if (part.type === "transformation") {
    return part as SessionTransformationMessagePartRecord
  }
  return part as DesktopStandardSessionPart
}

export function toDesktopSessionRecord(session: SessionRecord): DesktopSessionRecord {
  const desktop = readDesktopMetadata(session.metadata)
  const workspaceMode =
    desktop["workspaceMode"] === "outside_project" ||
    isOutsideProjectWorkspacePath(session.cwd, app.getPath("documents"))
      ? "outside_project"
      : "project"
  return { ...session, workspaceMode }
}

export function readDesktopMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const desktop = metadata["desktop"]
  return desktop && typeof desktop === "object" && !Array.isArray(desktop)
    ? { ...(desktop as Record<string, unknown>) }
    : {}
}

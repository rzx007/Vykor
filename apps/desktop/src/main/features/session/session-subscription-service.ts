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
  DesktopSessionRecord,
  DesktopSessionView,
  DesktopStandardSessionPart,
  OpenDesktopAuxSessionInput,
} from "../../../shared/session-types"
import { isOutsideProjectWorkspacePath } from "./outside-project-workspace"
import { pumpSubscription } from "./session-subscription-pump"
import { reserveSubscriptionSnapshot, SessionSubscriptionRegistry } from "./session-subscriptions"
import { app } from "electron"

const primarySubscriptionSlot = "primary"
type SessionSubscriptionClient = Parameters<typeof syncEvents>[0]

function auxiliarySubscriptionSlot(subscriptionId: string): string {
  return `aux:${subscriptionId}`
}

export class SessionSubscriptionService {
  private readonly subscriptions = new SessionSubscriptionRegistry()

  hasPrimary(webContentsId: number, sessionId: string): boolean {
    const sub = this.subscriptions.get(webContentsId, primarySubscriptionSlot)
    return sub?.sessionId === sessionId
  }

  closeDeletedSessions(webContentsId: number, sessionIds: readonly string[]): void {
    this.subscriptions.deleteMatchingSessions(webContentsId, new Set(sessionIds))
  }

  closeSession(webContentsId: number): void {
    this.subscriptions.clearOwner(webContentsId)
  }

  closeAuxSession(webContentsId: number, input: CloseDesktopAuxSessionInput): void {
    const subscriptionId = requireString(input.subscriptionId, "辅助订阅 ID")
    this.subscriptions.delete(webContentsId, auxiliarySubscriptionSlot(subscriptionId))
  }

  clearAll(): void {
    this.subscriptions.clearAll()
  }

  async openSession(
    client: SessionSubscriptionClient,
    webContents: WebContents,
    sessionIdInput: string
  ): Promise<DesktopSessionView> {
    const sessionId = requireString(sessionIdInput, "会话 ID")
    this.closeSession(webContents.id)

    const controller = new AbortController()
    const subscription = { controller, sessionId }
    webContents.once("destroyed", () => this.closeSession(webContents.id))
    const { snapshot, iterator } = await reserveSubscriptionSnapshot(
      this.subscriptions,
      webContents.id,
      primarySubscriptionSlot,
      subscription,
      async () => {
        return syncEvents(client, {
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
        iterator
      )
    }, 0)

    return toDesktopSessionView(snapshot.state, sessionId, snapshot.source)
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
    auxiliarySubscriptionId?: string
  ): Promise<void> {
    const subscription = this.subscriptions.get(webContents.id, slot)
    const send = (view: DesktopSessionView): void => {
      if (auxiliarySubscriptionId) {
        const payload: DesktopAuxSessionUpdate = { subscriptionId: auxiliarySubscriptionId, view }
        webContents.send(IpcEvents.sessionAuxUpdated, payload)
        return
      }
      webContents.send(IpcEvents.sessionUpdated, view)
    }

    await pumpSubscription<SyncEventUpdate>({
      initialIterator: iterator,
      createIterator: () =>
        syncEvents(client, { sessionId, signal: controller.signal })[Symbol.asyncIterator](),
      isActive: () =>
        !controller.signal.aborted &&
        !webContents.isDestroyed() &&
        Boolean(subscription) &&
        this.subscriptions.isCurrent(webContents.id, slot, subscription!),
      onUpdate: (update) => {
        if (!update.state.buckets[sessionId]?.session) {
          this.subscriptions.delete(webContents.id, slot)
          return
        }
        send(toDesktopSessionView(update.state, sessionId, update.source))
      },
      onReconnecting: (last) => send(toDesktopSessionView(last.state, sessionId, "reconnecting")),
      onError: (error) => {
        if (!controller.signal.aborted && !webContents.isDestroyed()) {
          console.error(`[session] sync failed for ${sessionId}`, error)
        }
      },
    })
  }
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

import type { WebContents } from "electron"
import {
  syncEvents,
  type OpenHarnessClient,
  type OpenHarnessClientState,
  type SessionAttachmentMessagePartRecord,
  type SessionMessagePartRecord,
  type SessionRecord,
  type SessionTransformationMessagePartRecord,
  type SyncEventUpdate,
} from "@openharness/client"

import { IpcEvents } from "../../../shared/ipc-channels"
import type {
  CloseDesktopAuxSessionInput,
  DesktopAuxSessionUpdate,
  DesktopPermissionMode,
  DesktopSessionPart,
  DesktopSessionRecord,
  DesktopSessionView,
  DesktopStandardSessionPart,
  OpenDesktopAuxSessionInput,
} from "../../../shared/session-types"
import { isOutsideProjectWorkspacePath } from "./outside-project-workspace"
import { reserveSubscriptionSnapshot, SessionSubscriptionRegistry } from "./session-subscriptions"
import { app } from "electron"

const primarySubscriptionSlot = "primary"

function auxiliarySubscriptionSlot(subscriptionId: string): string {
  return `aux:${subscriptionId}`
}

export class SessionSubscriptionService {
  private readonly subscriptions = new SessionSubscriptionRegistry()

  hasPrimary(webContentsId: number, sessionId: string): boolean {
    const sub = this.subscriptions.get(webContentsId, primarySubscriptionSlot)
    return sub?.sessionId === sessionId
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
    client: OpenHarnessClient,
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
      void this.pumpSession(webContents, primarySubscriptionSlot, sessionId, controller, iterator)
    }, 0)

    return toDesktopSessionView(snapshot.state, sessionId, snapshot.source)
  }

  async openAuxSession(
    client: OpenHarnessClient,
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
      void this.pumpSession(webContents, slot, sessionId, controller, iterator, subscriptionId)
    }, 0)
    return toDesktopSessionView(snapshot.state, sessionId, snapshot.source)
  }

  private async pumpSession(
    webContents: WebContents,
    slot: string,
    sessionId: string,
    controller: AbortController,
    iterator: AsyncIterator<SyncEventUpdate>,
    auxiliarySubscriptionId?: string
  ): Promise<void> {
    try {
      while (!controller.signal.aborted && !webContents.isDestroyed()) {
        const update = await iterator.next()
        if (update.done) return
        const current = this.subscriptions.get(webContents.id, slot)
        if (!current || current.controller !== controller || current.sessionId !== sessionId) return
        const view = toDesktopSessionView(update.value.state, sessionId, update.value.source)
        if (auxiliarySubscriptionId) {
          const payload: DesktopAuxSessionUpdate = {
            subscriptionId: auxiliarySubscriptionId,
            view,
          }
          webContents.send(IpcEvents.sessionAuxUpdated, payload)
        } else {
          webContents.send(IpcEvents.sessionUpdated, view)
        }
      }
    } catch (error) {
      if (!controller.signal.aborted && !webContents.isDestroyed()) {
        console.error(`[session] sync failed for ${sessionId}`, error)
      }
    }
  }
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label}不能为空。`)
  return value.trim()
}

export function toDesktopSessionView(
  state: OpenHarnessClientState,
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

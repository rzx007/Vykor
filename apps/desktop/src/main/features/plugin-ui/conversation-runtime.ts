import { createHash } from "node:crypto"
import {
  PluginUiBridgeError,
  parsePluginUiConversationReceipt,
  parsePluginUiSubmissionRecord,
  readPluginUiInstance,
  stringifyPluginUiJson,
  type PluginUiInstanceRecord,
  type PluginUiConversationRequest,
  type VykorClient,
} from "@vykor/client"
import type { DesktopSessionView } from "../../../shared/session-types"

export interface ConversationBinding {
  ownerId: number
  owner: object
  sessionId: string
  sessionToken: object | string
  targetSessionId: string
  sessionEpoch: number
  generation: number
  client: VykorClient
}
interface Pending extends ConversationBinding {
  instanceId: string
  sourcePartId: string
  pluginDigest: string
  componentDigest: string
  requestId: string
  fingerprint: string
  expectedRevision: number
}
/** Only the current window's outstanding admissions; mount revocation does not erase facts. */
export class PluginUiConversationRuntime {
  private readonly pending = new Map<string, Pending>()
  bind(
    binding: ConversationBinding,
    source: PluginUiInstanceRecord,
    requestId: string,
    input: PluginUiConversationRequest
  ): Pending {
    const fingerprint = createHash("sha256")
      .update(
        stringifyPluginUiJson({
          sessionId: binding.sessionId,
          instanceId: source.instanceId,
          expectedRevision: input.expectedRevision,
          text: input.text,
          data: input.data,
        })
      )
      .digest("hex")
    const previous = this.pending.get(requestId)
    if (previous) {
      if (
        previous.owner !== binding.owner ||
        previous.client !== binding.client ||
        previous.generation !== binding.generation ||
        previous.sessionEpoch !== binding.sessionEpoch ||
        previous.sessionId !== binding.sessionId ||
        previous.sessionToken !== binding.sessionToken ||
        previous.targetSessionId !== binding.targetSessionId ||
        previous.instanceId !== source.instanceId ||
        previous.fingerprint !== fingerprint
      )
        throw new PluginUiBridgeError("plugin_ui_request_conflict")
      return previous
    }
    if ([...this.pending.values()].filter((item) => item.ownerId === binding.ownerId).length >= 16)
      throw new PluginUiBridgeError("plugin_ui_too_many_requests")
    const pending = {
      ...binding,
      instanceId: source.instanceId,
      sourcePartId: source.sourcePartId,
      pluginDigest: source.pluginDigest,
      componentDigest: source.componentDigest,
      requestId,
      fingerprint,
      expectedRevision: input.expectedRevision,
    }
    this.pending.set(requestId, pending)
    return pending
  }
  get(ownerId: number, requestId: string): Pending {
    const pending = this.pending.get(requestId)
    if (!pending || pending.ownerId !== ownerId)
      throw new PluginUiBridgeError("plugin_ui_mount_closed")
    return pending
  }
  receipt(pending: Pending, value: unknown) {
    const receipt = parsePluginUiConversationReceipt(value)
    if (
      receipt.mode !== "submit" ||
      receipt.requestId !== pending.requestId ||
      receipt.instanceId !== pending.instanceId ||
      receipt.revision !== pending.expectedRevision + 1 ||
      (receipt.targetSessionId ?? pending.sessionId) !== pending.targetSessionId
    )
      throw new PluginUiBridgeError("plugin_ui_invalid_message")
    return receipt
  }
  releaseOwner(ownerId: number): void {
    for (const [id, pending] of this.pending)
      if (pending.ownerId === ownerId) this.pending.delete(id)
  }
  release(binding: ConversationBinding): void {
    for (const [id, pending] of this.pending) if (pending === binding) this.pending.delete(id)
  }
  retainSessions(ownerId: number, permits: (sessionId: string, sessionToken: object | string) => boolean): void {
    for (const [id, pending] of this.pending)
      if (pending.ownerId === ownerId && !permits(pending.sessionId, pending.sessionToken)) this.pending.delete(id)
  }
  releaseSession(ownerId: number, sessionId: string): void {
    for (const [id, pending] of this.pending)
      if (pending.ownerId === ownerId && pending.sessionId === sessionId) this.pending.delete(id)
  }
  observe(ownerId: number, view: DesktopSessionView): void {
    for (const [id, pending] of this.pending) {
      if (pending.ownerId !== ownerId || pending.sessionId !== view.session.id) continue
      if (view.syncStatus !== "connected") {
        this.pending.delete(id)
        continue
      }
      const part = view.parts.find((item) => item.id === pending.sourcePartId)
      const source = part && readPluginUiInstance(part.metadata)
      try {
        const fact = parsePluginUiSubmissionRecord(part?.metadata?.pluginUiSubmission)
        if (
          source?.instanceId === pending.instanceId &&
          source.sessionId === pending.sessionId &&
          fact.requestId === id &&
          fact.requestFingerprint === pending.fingerprint &&
          fact.expectedRevision === pending.expectedRevision &&
          (fact.targetSessionId ?? pending.sessionId) === pending.targetSessionId &&
          fact.pluginDigest === pending.pluginDigest &&
          fact.componentDigest === pending.componentDigest
        )
          this.pending.delete(id)
      } catch {
        /* An unrelated or incomplete snapshot cannot free an admission slot. */
      }
    }
  }
}

import { useEffect, useRef, useState } from "react"
import { PluginUiBridgeError, parsePluginUiConversationRequest, parsePluginUiConversationPrepared,
  parsePluginUiConversationReceipt, stringifyPluginUiJson, type PluginUiConversationReceipt,
  type PluginUiInstanceRecord, parsePluginUiSubmissionRecord, readPluginUiInstance } from "@vykor/client"
import { useDesktopSessionStore } from "@renderer/stores/desktop-session"
import { composerDocument } from "@renderer/stores/desktop-session/composer-document"
import { selectDraftDocument, sessionComposerScope } from "@renderer/stores/desktop-session/composer-draft-state"
import type { PluginUiConfirmationDetails } from "./plugin-ui-confirmation"

type SubmitReceipt = Extract<PluginUiConversationReceipt, { mode: "submit" }>
export function usePluginUiConversation(confirm: (details: PluginUiConfirmationDetails, signal: AbortSignal) => Promise<void>) {
  const sessionId = useDesktopSessionStore(state => state.activeSessionId)
  const syncStatus = useDesktopSessionStore(state => state.sessionView?.syncStatus)
  const view = useDesktopSessionStore(state => state.sessionView)
  const ownerScope = useRef({ sessionId, syncStatus })
  if (ownerScope.current.sessionId !== sessionId || ownerScope.current.syncStatus !== syncStatus)
    ownerScope.current = { sessionId, syncStatus }
  const capturedScope = ownerScope.current
  const added = useRef(new Set<string>())
  const submitted = useRef(new Map<string, string>())
  const [status, setStatus] = useState<{ message: string; requestId?: string } | null>(null)
  useEffect(() => { added.current.clear(); submitted.current.clear(); setStatus(null) }, [sessionId, syncStatus])
  useEffect(() => {
    for (const part of view?.parts ?? []) {
      try {
        const fact = parsePluginUiSubmissionRecord(part.metadata?.pluginUiSubmission)
        if (submitted.current.get(fact.requestFingerprint) !== fact.requestId) continue
        const receipt = snapshotReceipt(fact.requestId)
        if (receipt) { submitted.current.delete(fact.requestFingerprint); showReceipt(receipt) }
      } catch { /* Only the matching trusted source fact resolves an uncertain submission. */ }
    }
  }, [view])
  const snapshotReceipt = (requestId: string): SubmitReceipt | undefined => {
    const current = useDesktopSessionStore.getState().sessionView
    if (current?.session.id !== sessionId || current.syncStatus !== "connected") return
    for (const part of current.parts) {
      try {
        const source = readPluginUiInstance(part.metadata), fact = parsePluginUiSubmissionRecord(part.metadata?.pluginUiSubmission)
        if (!source || source.sourcePartId !== part.id || source.sessionId !== sessionId || fact.requestId !== requestId
          || fact.pluginDigest !== source.pluginDigest || fact.componentDigest !== source.componentDigest
          || source.revision < fact.expectedRevision + 1) continue
        const runStatus = current.runs.find(run => run.id === fact.runId)?.status
        return parsePluginUiConversationReceipt({ kind: "conversation", mode: "submit", instanceId: source.instanceId,
          revision: fact.expectedRevision + 1, requestId, inputId: fact.inputId, runId: fact.runId,
          status: runStatus ?? "pending" }) as SubmitReceipt
      } catch { /* Keep unrelated metadata out of host receipts. */ }
    }
    return
  }
  const showReceipt = (receipt: SubmitReceipt) => {
    if (ownerScope.current !== capturedScope || useDesktopSessionStore.getState().activeSessionId !== sessionId
      || useDesktopSessionStore.getState().sessionView?.syncStatus !== "connected") throw new PluginUiBridgeError("plugin_ui_mount_closed")
    setStatus({ message: receipt.status === "failed" || receipt.status === "interrupted"
      ? "已交给助手，但运行失败或中断。请在原会话中重试。" : "已交给助手。" })
    return receipt
  }
  const query = async (requestId: string) => {
    try {
      const receipt = parsePluginUiConversationReceipt(await window.desktop.pluginUi.getConversationSubmission({ requestId }))
      if (receipt.mode !== "submit" || receipt.requestId !== requestId) throw new PluginUiBridgeError("plugin_ui_invalid_message")
      return showReceipt(receipt)
    } catch {
      if (ownerScope.current !== capturedScope || useDesktopSessionStore.getState().activeSessionId !== sessionId
        || useDesktopSessionStore.getState().sessionView?.syncStatus !== "connected") throw new PluginUiBridgeError("plugin_ui_mount_closed")
      const observed = snapshotReceipt(requestId)
      if (observed) return showReceipt(observed)
      setStatus({ requestId, message: "尚未确认是否已接收。可查询原请求；重试请回到原交互页面并重新确认相同内容。" })
      throw new PluginUiBridgeError("plugin_ui_submission_unknown")
    }
  }
  const request = async (mountId: string, instance: PluginUiInstanceRecord, params: unknown, signal: AbortSignal,
    isValid: () => boolean, markAccepted: () => void, bridgeRequestId: string) => {
    const input = parsePluginUiConversationRequest(params)
    const check = () => {
      if (ownerScope.current !== capturedScope || signal.aborted || !isValid() || useDesktopSessionStore.getState().activeSessionId !== instance.sessionId)
        throw new PluginUiBridgeError("plugin_ui_mount_closed")
    }
    check()
    const addedId = mountId + ":" + bridgeRequestId
    if (input.mode === "draft" && added.current.has(addedId)) return { kind: "conversation", mode: "draft",
      instanceId: instance.instanceId, revision: input.expectedRevision, added: true } as const
    const api = window.desktop.pluginUi
    const prepared = parsePluginUiConversationPrepared(await api.prepareConversation({ mountId, input }))
    check()
    if (prepared.mode !== input.mode || prepared.instanceId !== instance.instanceId || prepared.revision !== input.expectedRevision)
      throw new PluginUiBridgeError("plugin_ui_invalid_message")
    await confirm({ instance, label: input.mode === "draft" ? "将以下完整内容加入输入框" : "将以下完整内容交给助手",
      args: {}, conversation: prepared }, signal)
    check()
    const verified = parsePluginUiConversationPrepared(await api.prepareConversation({ mountId, input }))
    check()
    if (verified.mode !== prepared.mode || verified.instanceId !== prepared.instanceId
      || verified.revision !== prepared.revision || verified.promptText !== prepared.promptText)
      throw new PluginUiBridgeError("plugin_ui_snapshot_changed")
    if (input.mode === "draft") {
      if (!added.current.has(addedId)) {
        const store = useDesktopSessionStore.getState(), scope = sessionComposerScope(instance.sessionId)
        const current = selectDraftDocument(store, scope)
        store.setComposerDraftDocument(scope, composerDocument([...current.items, { type: "text", text: "\n\n" + prepared.promptText }]))
        added.current.add(addedId)
      }
      markAccepted()
      setStatus({ message: "已加入输入框。" })
      return { kind: "conversation", mode: "draft", instanceId: instance.instanceId, revision: prepared.revision, added: true } as const
    }
    // Keep only a fingerprint and trusted request ID for confirmed submissions, never frame form state.
    const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stringifyPluginUiJson({ sessionId: instance.sessionId,
      instanceId: instance.instanceId, expectedRevision: input.expectedRevision, text: input.text, data: input.data })))
    const fingerprint = Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("")
    check()
    if (!submitted.current.has(fingerprint) && submitted.current.size >= 16) throw new PluginUiBridgeError("plugin_ui_too_many_requests")
    const requestId = submitted.current.get(fingerprint) ?? crypto.randomUUID()
    submitted.current.set(fingerprint, requestId)
    const { mode: _mode, ...payload } = input
    let timer: ReturnType<typeof setTimeout> | undefined
    markAccepted()
    try {
      const receipt = parsePluginUiConversationReceipt(await Promise.race([
        api.submitConversation({ mountId, requestId, input: payload }),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new PluginUiBridgeError("plugin_ui_timeout")), 30_000) }),
      ]))
      if (receipt.mode !== "submit" || receipt.requestId !== requestId || receipt.instanceId !== instance.instanceId
        || receipt.revision !== input.expectedRevision + 1) throw new PluginUiBridgeError("plugin_ui_invalid_message")
      return showReceipt(receipt)
    } catch (error) {
      const code = error instanceof Error ? error.message.match(/\bplugin_ui_[a-z_]+\b/)?.[0] : undefined
      if (code && !["plugin_ui_unavailable", "plugin_ui_timeout", "plugin_ui_invalid_message"].includes(code)) {
        if (ownerScope.current === capturedScope && useDesktopSessionStore.getState().activeSessionId === sessionId
          && useDesktopSessionStore.getState().sessionView?.syncStatus === "connected") {
          if (submitted.current.get(fingerprint) === requestId) submitted.current.delete(fingerprint)
          setStatus({ message: "未能交给助手。请在原会话中重试。" })
        }
        throw error
      }
      return await query(requestId)
    } finally { clearTimeout(timer) }
  }
  return { request, status, query }
}

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import {
  PluginUiBridgeError,
  parsePluginUiConversationRequest,
  parsePluginUiConversationPrepared,
  parsePluginUiConversationReceipt,
  stringifyPluginUiJson,
  type PluginUiConversationReceipt,
  type PluginUiInstanceRecord,
  parsePluginUiSubmissionRecord,
  readPluginUiInstance,
} from "@vykor/client"
import { useDesktopSessionStore } from "@renderer/stores/desktop-session"
import { composerDocument } from "@renderer/stores/desktop-session/composer-document"
import {
  selectDraftDocument,
  sessionComposerScope,
} from "@renderer/stores/desktop-session/composer-draft-state"
import type { PluginUiConfirmationDetails } from "./plugin-ui-confirmation"
import type { DesktopSessionView } from "@shared/session-types"

type SubmitReceipt = Extract<PluginUiConversationReceipt, { mode: "submit" }>
export function usePluginUiConversation(
  confirm: (details: PluginUiConfirmationDetails, signal: AbortSignal) => Promise<void>,
  sourceView?: DesktopSessionView | null
) {
  const primarySessionId = useDesktopSessionStore((state) => state.activeSessionId)
  const primaryView = useDesktopSessionStore((state) => state.sessionView)
  const view = sourceView === undefined ? primaryView : sourceView
  const sessionId = view?.session.id
  const syncStatus = view?.syncStatus
  const generation = view?.session.metadata.pluginUiGeneration
  const viewRef = useRef(view)
  useLayoutEffect(() => {
    viewRef.current = view
  }, [view])
  const [capturedScope, setCapturedScope] = useState({
    primarySessionId,
    sessionId,
    syncStatus,
    generation,
  })
  const ownerScope = useRef(capturedScope)
  const added = useRef(new Map<string, string | undefined>())
  const submitted = useRef(new Map<string, string>())
  const [status, setStatus] = useState<{ message: string; requestId?: string } | null>(null)
  if (
    capturedScope.primarySessionId !== primarySessionId ||
    capturedScope.sessionId !== sessionId ||
    capturedScope.syncStatus !== syncStatus ||
    !Object.is(capturedScope.generation, generation)
  ) {
    setCapturedScope({ primarySessionId, sessionId, syncStatus, generation })
    setStatus(null)
  }
  useLayoutEffect(() => {
    ownerScope.current = capturedScope
    added.current.clear()
    submitted.current.clear()
  }, [capturedScope])
  const snapshotReceipt = useCallback(
    (requestId: string): SubmitReceipt | undefined => {
      const current = viewRef.current
      if (!current || current.session.id !== sessionId || current.syncStatus !== "connected") return
      for (const part of current.parts) {
        try {
          const source = readPluginUiInstance(part.metadata),
            fact = parsePluginUiSubmissionRecord(part.metadata?.pluginUiSubmission)
          if (
            !source ||
            source.sourcePartId !== part.id ||
            source.sessionId !== sessionId ||
            fact.requestId !== requestId ||
            fact.pluginDigest !== source.pluginDigest ||
            fact.componentDigest !== source.componentDigest ||
            source.revision < fact.expectedRevision + 1
          )
            continue
          const runStatus = current.runs.find((run) => run.id === fact.runId)?.status
          return parsePluginUiConversationReceipt({
            kind: "conversation",
            mode: "submit",
            instanceId: source.instanceId,
            revision: fact.expectedRevision + 1,
            requestId,
            inputId: fact.inputId,
            runId: fact.runId,
            ...(fact.targetSessionId ? { targetSessionId: fact.targetSessionId } : {}),
            status: runStatus ?? "pending",
          }) as SubmitReceipt
        } catch {
          /* Keep unrelated metadata out of host receipts. */
        }
      }
      return
    },
    [sessionId]
  )
  const showReceipt = useCallback(
    (receipt: SubmitReceipt) => {
      if (
        ownerScope.current !== capturedScope ||
        useDesktopSessionStore.getState().activeSessionId !== primarySessionId ||
        viewRef.current?.syncStatus !== "connected"
      )
        throw new PluginUiBridgeError("plugin_ui_mount_closed")
      if ((receipt.targetSessionId ?? sessionId) !== primarySessionId)
        throw new PluginUiBridgeError("plugin_ui_invalid_message")
      setStatus({
        message:
          receipt.status === "failed" || receipt.status === "interrupted"
            ? "已交给助手，但运行失败或中断。请在原会话中重试。"
            : "已交给助手。",
      })
      return receipt
    },
    [capturedScope, primarySessionId, sessionId]
  )
  useEffect(() => {
    // The existing source stream supplies receipts for both primary and auxiliary sessions.
    if (submitted.current.size === 0) return
    for (const part of view?.parts ?? []) {
      try {
        const fact = parsePluginUiSubmissionRecord(part.metadata?.pluginUiSubmission)
        if (submitted.current.get(fact.requestFingerprint) !== fact.requestId) continue
        const receipt = snapshotReceipt(fact.requestId)
        if (receipt) {
          submitted.current.delete(fact.requestFingerprint)
          showReceipt(receipt)
        }
      } catch {
        /* Only the matching trusted source fact resolves an uncertain submission. */
      }
    }
  }, [view, snapshotReceipt, showReceipt])
  const query = async (requestId: string) => {
    try {
      const receipt = parsePluginUiConversationReceipt(
        await window.desktop.pluginUi.getConversationSubmission({ requestId })
      )
      if (receipt.mode !== "submit" || receipt.requestId !== requestId)
        throw new PluginUiBridgeError("plugin_ui_invalid_message")
      return showReceipt(receipt)
    } catch {
      if (
        ownerScope.current !== capturedScope ||
        useDesktopSessionStore.getState().activeSessionId !== primarySessionId ||
        viewRef.current?.syncStatus !== "connected"
      )
        throw new PluginUiBridgeError("plugin_ui_mount_closed")
      const observed = snapshotReceipt(requestId)
      if (observed) return showReceipt(observed)
      setStatus({
        requestId,
        message: "尚未确认是否已接收。可查询原请求；重试请回到原交互页面并重新确认相同内容。",
      })
      throw new PluginUiBridgeError("plugin_ui_submission_unknown")
    }
  }
  const request = async (
    mountId: string,
    instance: PluginUiInstanceRecord,
    params: unknown,
    signal: AbortSignal,
    isValid: () => boolean,
    markAccepted: () => void,
    bridgeRequestId: string
  ) => {
    const input = parsePluginUiConversationRequest(params)
    const { mode, ...payload } = input
    const check = () => {
      if (
        ownerScope.current !== capturedScope ||
        signal.aborted ||
        !isValid() ||
        useDesktopSessionStore.getState().activeSessionId !== primarySessionId ||
        instance.sessionId !== sessionId
      )
        throw new PluginUiBridgeError("plugin_ui_mount_closed")
    }
    check()
    const addedId = mountId + ":" + bridgeRequestId
    if (mode === "draft" && added.current.has(addedId))
      return {
        kind: "conversation",
        mode: "draft",
        instanceId: instance.instanceId,
        revision: input.expectedRevision,
        added: true,
        ...(added.current.get(addedId) ? { targetSessionId: added.current.get(addedId) } : {}),
      } as const
    const api = window.desktop.pluginUi
    const prepared = parsePluginUiConversationPrepared(
      await api.prepareConversation({ mountId, input })
    )
    check()
    if (
      prepared.mode !== input.mode ||
      prepared.instanceId !== instance.instanceId ||
      prepared.revision !== input.expectedRevision
    )
      throw new PluginUiBridgeError("plugin_ui_invalid_message")
    const targetSessionId = prepared.targetSessionId ?? instance.sessionId
    if (targetSessionId !== primarySessionId)
      throw new PluginUiBridgeError("plugin_ui_conversation_unavailable")
    await confirm(
      {
        instance,
        label: input.mode === "draft" ? "将以下完整内容加入输入框" : "将以下完整内容交给助手",
        args: {},
        conversation: prepared,
      },
      signal
    )
    check()
    const verified = parsePluginUiConversationPrepared(
      await api.prepareConversation({ mountId, input })
    )
    check()
    if (
      verified.mode !== prepared.mode ||
      verified.instanceId !== prepared.instanceId ||
      verified.revision !== prepared.revision ||
      verified.promptText !== prepared.promptText ||
      verified.targetSessionId !== prepared.targetSessionId
    )
      throw new PluginUiBridgeError("plugin_ui_snapshot_changed")
    if (mode === "draft") {
      if (!added.current.has(addedId)) {
        const store = useDesktopSessionStore.getState(),
          scope = sessionComposerScope(targetSessionId)
        const current = selectDraftDocument(store, scope)
        store.setComposerDraftDocument(
          scope,
          composerDocument([...current.items, { type: "text", text: "\n\n" + prepared.promptText }])
        )
        added.current.set(addedId, prepared.targetSessionId)
      }
      markAccepted()
      setStatus({ message: "已加入输入框。" })
      return {
        kind: "conversation",
        mode: "draft",
        instanceId: instance.instanceId,
        revision: prepared.revision,
        added: true,
        ...(prepared.targetSessionId ? { targetSessionId: prepared.targetSessionId } : {}),
      } as const
    }
    // Keep only a fingerprint and trusted request ID for confirmed submissions, never frame form state.
    const bytes = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(
        stringifyPluginUiJson({
          sessionId: instance.sessionId,
          instanceId: instance.instanceId,
          expectedRevision: input.expectedRevision,
          text: input.text,
          data: input.data,
        })
      )
    )
    const fingerprint = Array.from(new Uint8Array(bytes), (byte) =>
      byte.toString(16).padStart(2, "0")
    ).join("")
    check()
    if (!submitted.current.has(fingerprint) && submitted.current.size >= 16)
      throw new PluginUiBridgeError("plugin_ui_too_many_requests")
    const requestId = submitted.current.get(fingerprint) ?? crypto.randomUUID()
    submitted.current.set(fingerprint, requestId)
    let timer: ReturnType<typeof setTimeout> | undefined
    markAccepted()
    try {
      const receipt = parsePluginUiConversationReceipt(
        await Promise.race([
          api.submitConversation({ mountId, requestId, input: payload }),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new PluginUiBridgeError("plugin_ui_timeout")), 30_000)
          }),
        ])
      )
      if (
        receipt.mode !== "submit" ||
        receipt.requestId !== requestId ||
        receipt.instanceId !== instance.instanceId ||
        receipt.revision !== input.expectedRevision + 1 ||
        (receipt.targetSessionId ?? instance.sessionId) !== targetSessionId
      )
        throw new PluginUiBridgeError("plugin_ui_invalid_message")
      return showReceipt(receipt)
    } catch (error) {
      const code =
        error instanceof Error ? error.message.match(/\bplugin_ui_[a-z_]+\b/)?.[0] : undefined
      if (
        code &&
        !["plugin_ui_unavailable", "plugin_ui_timeout", "plugin_ui_invalid_message"].includes(code)
      ) {
        if (
          ownerScope.current === capturedScope &&
          useDesktopSessionStore.getState().activeSessionId === primarySessionId &&
          viewRef.current?.syncStatus === "connected"
        ) {
          if (submitted.current.get(fingerprint) === requestId)
            submitted.current.delete(fingerprint)
          setStatus({ message: "未能交给助手。请在原会话中重试。" })
        }
        throw error
      }
      return await query(requestId)
    } finally {
      clearTimeout(timer)
    }
  }
  return { request, status, query }
}

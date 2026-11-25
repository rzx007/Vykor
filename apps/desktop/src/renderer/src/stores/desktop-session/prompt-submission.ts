import { clearSubmittedDraft } from "./composer-draft-state"
import { pluginAppModelContexts } from "@renderer/components/desktop/shell/plugin-apps/plugin-app-model-context"
import { isTransientComposerSession, saveComposerRecovery } from "./composer-recovery"
import { errorMessage } from "./error-state"
import {
  acknowledgeOperation,
  beginOperation,
  createEmptySessionRuntime,
  failOperation,
  removeOperation,
} from "./operation-state"
import {
  FOLLOW_UP_TARGET_UNAVAILABLE,
  isTranscriptFollowUp,
  removePendingPromptSubmission,
  updatePendingPromptSubmission,
} from "./pending-prompt-state"
import type { DesktopSessionRuntime, DesktopStoreContext, PendingPromptSubmission, PromptActions } from "./types"

// All prompt entry points use the same durable identity, in-flight result and settlement.
export function createPromptSubmissionSender(
  context: DesktopStoreContext & {
    scheduleSelectedProjectGitRefresh: (force: boolean) => void
  }
): PromptActions["submitPromptSubmission"] {
  const { get, set } = context
  const inFlight = new Map<string, Promise<void>>()
  return (pending, mode) => {
    const existing = inFlight.get(pending.id)
    if (existing) return existing
    if (pending.phase === "accepted") return Promise.resolve()
    set((state) => {
      const runtime = state.sessionRuntimes[pending.sessionId] ?? createEmptySessionRuntime()
      const submitting: DesktopSessionRuntime = {
        ...runtime,
        pendingPromptSubmissions: {
          ...runtime.pendingPromptSubmissions,
          [pending.id]: { ...pending, phase: "submitting", dismissed: false, error: undefined },
        },
      }
      return {
        sessionRuntimes: {
          ...state.sessionRuntimes,
          [pending.sessionId]:
            runtime.operations[pending.id]?.kind === "create-session"
              ? submitting
              : beginOperation(submitting, {
                  id: pending.id,
                  kind: "send-prompt",
                  sessionId: pending.sessionId,
                  startedAt: Date.now(),
                }),
        },
      }
    })
    const request = send()
    inFlight.set(pending.id, request)
    void request
      .finally(() => {
        if (inFlight.get(pending.id) === request) inFlight.delete(pending.id)
      })
      .catch(() => undefined)
    return request

    async function send(): Promise<void> {
      try {
        const enableInteractiveUi = pending.delivery !== "steer" && (
          pending.interactiveUiEnabled === true || (mode !== "retry" &&
            (await window.desktop.settings?.getInteractiveUiEnabled?.().catch(() => false)) === true)
        )
        const accepted =
          mode === "retry" &&
          (await window.desktop.sessions.checkPromptAccepted({
            sessionId: pending.sessionId,
            inputId: pending.id,
          }))
        if (!get().sessionRuntimes[pending.sessionId]) return
        const current =
          get().sessionRuntimes[pending.sessionId]?.pendingPromptSubmissions[pending.id]
        if (!accepted && current && current.phase !== "accepted") {
          if (enableInteractiveUi && !current.interactiveUiEnabled) {
            set((state) => {
              const runtime = state.sessionRuntimes[pending.sessionId]!
              return {
                sessionRuntimes: {
                  ...state.sessionRuntimes,
                  [pending.sessionId]: {
                    ...runtime,
                    pendingPromptSubmissions: updatePendingPromptSubmission(
                      runtime.pendingPromptSubmissions,
                      pending.id,
                      (submission) => ({ ...submission, interactiveUiEnabled: true })
                    ),
                  },
                },
              }
            })
          }
          // A failed write must prevent admission, otherwise a restart could lose the original ID.
          if (
            !isTransientComposerSession(get(), pending.sessionId) &&
            !(await saveComposerRecovery(get()))
          ) {
            throw new Error("无法保存发送记录，本次未提交。请释放本机存储空间后重试。")
          }
          if (!get().sessionRuntimes[pending.sessionId]?.pendingPromptSubmissions[pending.id]) return
          const request: Parameters<typeof window.desktop.sessions.sendPrompt>[0] = {
            id: pending.id,
            sessionId: pending.sessionId,
            ...(enableInteractiveUi ? { interactiveUiEnabled: true } : {}),
            ...(current.delivery === undefined ? {} : { delivery: current.delivery }),
            ...(current.expectedActiveRunId === undefined ? {} : { expectedActiveRunId: current.expectedActiveRunId }),
            items: current.browserAnnotationContext
              ? [...current.items, { type: "text", text: current.browserAnnotationContext }]
              : current.items,
            ...(pending.pluginAppContextIds?.length
              ? { pluginAppContextIds: pending.pluginAppContextIds }
              : {}),
            attachments: pending.attachments.map(({ assetId, intent, displayName }) => ({
              assetId,
              intent,
              displayName,
            })),
          }
          await window.desktop.sessions.sendPrompt(request)
        }
        settlePromptSubmission(context, pending)
        if (accepted && get().activeSessionId === pending.sessionId)
          await get().resyncActiveSessionSnapshot()
      } catch (error) {
        const message = errorMessage(error)
        const feedback = pending.delivery === "steer" && /active_run_changed|steer_delivery_failed|targeting an active Run/.test(message)
          ? FOLLOW_UP_TARGET_UNAVAILABLE
          : message
        if (!settlePromptSubmission(context, pending, feedback)) throw feedback === message ? error : new Error(feedback)
      } finally {
        context.scheduleSelectedProjectGitRefresh(true)
      }
    }
  }
}

export function settlePromptSubmission(
  context: DesktopStoreContext,
  pending: PendingPromptSubmission,
  error?: string
): boolean {
  const { get, set } = context
  const runtime = get().sessionRuntimes[pending.sessionId]
  if (!runtime) return error === undefined
  const current = runtime.pendingPromptSubmissions[pending.id]
  const confirmed =
    !current ||
    current.phase === "accepted" ||
    Boolean(
      get().sessionView?.session.id === pending.sessionId &&
      get().sessionView?.inputs.some((input) => input.id === pending.id)
    )
  const accepted = error === undefined || confirmed
  if (accepted)
    for (const id of pending.pluginAppContextIds ?? []) pluginAppModelContexts.remove(id)
  set((state) => {
    const currentRuntime = state.sessionRuntimes[pending.sessionId]
    if (!currentRuntime) return state
    if (!accepted && current?.phase === "failed" && current.error === error) return state
    let next = {
      ...currentRuntime,
      pendingPromptSubmissions: updatePendingPromptSubmission(
        currentRuntime.pendingPromptSubmissions,
        pending.id,
        (value) => ({
          ...value,
          phase: accepted ? "accepted" : "failed",
          error: accepted ? undefined : error,
        })
      ),
    }
    if (accepted) {
      next =
        error === undefined
          ? acknowledgeOperation(next, pending.id, Date.now())
          : removeOperation(next, pending.id)
      // Auxiliary streams also reconcile direct follow-ups with the final transcript message.
      if (state.activeSessionId !== pending.sessionId && !isTranscriptFollowUp(pending))
        next = removeOperation(
          {
            ...next,
            pendingPromptSubmissions: removePendingPromptSubmission(
              next.pendingPromptSubmissions,
              pending.id
            ),
          },
          pending.id
        )
    } else if (error !== undefined && next.operations[pending.id]?.kind !== "create-session")
      next = failOperation(next, pending.id, error, Date.now())
    return {
      ...(accepted && current && current.phase !== "accepted" ? clearSubmittedDraft(state, pending) : {}),
      sessionRuntimes: { ...state.sessionRuntimes, [pending.sessionId]: next },
    }
  })
  return accepted
}

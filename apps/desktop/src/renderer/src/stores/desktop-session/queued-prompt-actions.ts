import { selectSessionInterrupting } from "./selectors"
import { errorMessage } from "./error-state"
import {
  acknowledgeOperation,
  beginOperation,
  createEmptySessionRuntime,
  failOperation,
  removeOperation,
} from "./operation-state"
import { queuedPromptActionConfirmed, queuedPromptActionKey } from "./pending-prompt-state"
import type {
  DesktopSessionRuntime,
  DesktopStoreContext,
  QueuedPromptAction,
  QueuedPromptActions,
} from "./types"

interface QueuedPromptActionsContext extends DesktopStoreContext {
  scheduleSelectedProjectGitRefresh: (force: boolean) => void
}

export function createQueuedPromptActions(
  context: QueuedPromptActionsContext
): QueuedPromptActions {
  const { get, set } = context

  return {
    async promoteQueuedPrompt(inputId, queuedRunId, expectedActiveRunId, targetSessionId) {
      if (!expectedActiveRunId) return
      await runAction("promote", inputId, queuedRunId, targetSessionId, (sessionId) =>
        window.desktop.sessions.promoteQueuedPrompt({ sessionId, inputId, queuedRunId, expectedActiveRunId })
      )
    },

    cancelQueuedPrompt(inputId, queuedRunId, targetSessionId) {
      return runAction("cancel", inputId, queuedRunId, targetSessionId, (sessionId) =>
        window.desktop.sessions.cancelQueuedPrompt({ sessionId, inputId, queuedRunId })
      )
    },
  }

  async function runAction(
    kind: QueuedPromptAction["kind"],
    inputId: string,
    runId: string,
    targetSessionId: string | undefined,
    request: (sessionId: string) => Promise<void>
  ): Promise<void> {
    const state = get()
    const sessionId = targetSessionId ?? state.activeSessionId
    if (!sessionId || !inputId || !runId) return
    if (kind === "promote" && selectSessionInterrupting(state, sessionId)) return

    const key = queuedPromptActionKey(sessionId, runId)
    const previous = state.sessionRuntimes[sessionId]?.queuedPromptActions[key]
    if (previous?.phase === "pending" && (kind === "promote" || previous.kind === "cancel")) return
    const action: QueuedPromptAction = { sessionId, inputId, runId, kind, phase: "pending" }

    updateRuntime(runtime => beginOperation(
      {
        ...runtime,
        queuedPromptActions: { ...runtime.queuedPromptActions, [key]: action },
      },
      {
        id: key,
        kind: kind === "promote" ? "promote-prompt" : "cancel-prompt",
        sessionId,
        target: runId,
        startedAt: Date.now(),
      }
    ))
    try {
      await request(sessionId)
      settle()
    } catch (error) {
      settle(queuedPromptActionError(kind, error))
    } finally {
      context.scheduleSelectedProjectGitRefresh(true)
    }

    function settle(error?: string): void {
      updateRuntime(runtime => {
        // A cancellation or newer snapshot can replace the action before its reply arrives.
        if (runtime.queuedPromptActions[key] !== action) return runtime
        const current = get()
        if (queuedPromptActionConfirmed(current.sessionView, action) ||
            (error === undefined && targetSessionId === undefined && current.activeSessionId !== sessionId))
          return removeActionAndOperation(runtime, key)
        const next: DesktopSessionRuntime = {
          ...runtime,
          queuedPromptActions: {
            ...runtime.queuedPromptActions,
            [key]: { ...action, phase: error === undefined ? "acknowledged" : "failed", error },
          },
        }
        return error === undefined
          ? acknowledgeOperation(next, key, Date.now())
          : failOperation(next, key, error, Date.now())
      })
    }

    function updateRuntime(update: (runtime: DesktopSessionRuntime) => DesktopSessionRuntime): void {
      set(current => {
        const before = current.sessionRuntimes[action.sessionId] ?? createEmptySessionRuntime()
        const after = update(before)
        return after === before ? current : {
          sessionRuntimes: { ...current.sessionRuntimes, [action.sessionId]: after },
        }
      })
    }
  }
}

function removeActionAndOperation(
  runtime: DesktopSessionRuntime,
  actionKey: string
): DesktopSessionRuntime {
  const actions = { ...runtime.queuedPromptActions }
  delete actions[actionKey]
  return removeOperation({ ...runtime, queuedPromptActions: actions }, actionKey)
}

function queuedPromptActionError(kind: "promote" | "cancel", error: unknown): string {
  const message = errorMessage(error)
  if (kind === "promote" && /active run|当前运行|target run|409/i.test(message)) {
    return "当前回答已经切换，这条消息仍保留在待处理队列中。"
  }
  return kind === "promote" ? `调整方向失败：${message}` : `删除失败：${message}`
}

import { pluginAppModelContexts } from "@renderer/components/desktop/shell/plugin-apps/plugin-app-model-context"
import { errorMessage } from "./error-state"
import { createPromptSubmissionSender } from "./prompt-submission"
import { markComposerSessionTransient } from "./composer-recovery"
import {
  beginOperation,
  createEmptySessionRuntime,
  failOperation,
  removeOperation,
} from "./operation-state"
import { classifyPromptPlacement, updatePendingPromptSubmission } from "./pending-prompt-state"
import type {
  DesktopSessionRuntime,
  DesktopStoreContext,
  PendingPromptEdit,
  PendingPromptSubmission,
  PromptActions,
} from "./types"
import { composerDocument, selectComposerDocumentText } from "./composer-document"

interface PromptActionsContext extends DesktopStoreContext {
  scheduleSelectedProjectGitRefresh: (force: boolean) => void
}

export function createPromptActions(context: PromptActionsContext): PromptActions {
  const { get, set } = context
  return {
    submitPromptSubmission: createPromptSubmissionSender(context),
    async retryPromptSubmission(inputId, targetSessionId) {
      const sessionId = targetSessionId ?? get().activeSessionId
      if (!sessionId || get().pendingModeChanges[sessionId]) return
      const pending = get().sessionRuntimes[sessionId]?.pendingPromptSubmissions[inputId]
      if (pending) await get().submitPromptSubmission(pending, "retry")
    },
    dismissPromptSubmission(inputId) {
      const sessionId = get().activeSessionId
      if (!sessionId) return
      replaceRuntime(sessionId, (runtime) =>
        removeOperation(
          {
            ...runtime,
            pendingPromptSubmissions: updatePendingPromptSubmission(
              runtime.pendingPromptSubmissions,
              inputId,
              (value) => ({ ...value, dismissed: true })
            ),
          },
          inputId
        )
      )
    },
    async sendMessage(content, options) {
      const document = options?.document ?? composerDocument([{ type: "text", text: content }])
      const items = [...(options?.contextItems ?? []), ...document.items]
      const prompt = selectComposerDocumentText({ ...document, items })
      const sessionId = options?.target?.sessionId ?? get().activeSessionId
      if (options?.target?.view?.session.storage === "memory")
        markComposerSessionTransient(options.target.sessionId)
      if (sessionId && get().pendingModeChanges[sessionId]) return
      const appContexts = pluginAppModelContexts.forSession(sessionId ?? null)
      const attachmentDrafts = [...(options?.attachments ?? [])]
      if (!sessionId || attachmentDrafts.some((attachment) => attachment.status !== "ready")) return
      const attachments = attachmentDrafts.flatMap((attachment) =>
        attachment.assetId && attachment.mediaType
          ? [
              {
                assetId: attachment.assetId,
                intent: "auto" as const,
                displayName: attachment.displayName,
                mediaType: attachment.mediaType,
                sizeBytes: attachment.sizeBytes,
              },
            ]
          : []
      )
      if (
        attachments.length !== attachmentDrafts.length ||
        (!hasMeaningfulItems(items) && attachments.length === 0 && appContexts.length === 0)
      ) {
        return
      }

      const current = get()
      const runtime = getSessionRuntime(current, sessionId)
      const matching = Object.values(runtime.pendingPromptSubmissions).find(
        (submission) =>
          submission.content === prompt &&
          JSON.stringify(submission.pluginAppContextIds ?? []) ===
            JSON.stringify(appContexts.map((entry) => entry.id)) &&
          sameInputItems(submission.items, items) &&
          sameAttachmentSnapshot(submission.attachments, attachments)
      )
      if (matching) {
        if (matching.phase === "failed") await get().retryPromptSubmission(matching.id, sessionId)
        else await get().submitPromptSubmission(matching)
        return
      }
      const submission: PendingPromptSubmission = {
        id: globalThis.crypto.randomUUID(),
        sessionId,
        content: prompt,
        ...(appContexts.length
          ? { pluginAppContextIds: appContexts.map((entry) => entry.id) }
          : {}),
        items,
        draftDocument: document,
        draftAttachmentIds: attachmentDrafts.map((attachment) => attachment.draftId),
        attachments,
        createdAt: Date.now(),
        phase: "submitting",
        placement: classifyPromptPlacement(
          options?.target ? options.target.view : current.sessionView,
          runtime,
          sessionId
        ),
      }

      return get().submitPromptSubmission(submission)
    },

    async editLatestMessage(
      sourceMessageId,
      content,
      document = composerDocument([{ type: "text", text: content }])
    ) {
      const prompt = selectComposerDocumentText(document)
      const items = document.items
      const current = get()
      const sessionId = current.activeSessionId
      if (sessionId && current.pendingModeChanges[sessionId]) return
      const sourceMessage = current.sessionView?.messages.find(
        (message) => message.id === sourceMessageId && message.role === "user"
      )
      const sourceInput = sourceMessage?.inputId
        ? current.sessionView?.inputs.find((input) => input.id === sourceMessage.inputId)
        : undefined
      const attachments = [...(sourceInput?.attachments ?? [])]
        .sort((left, right) => left.seq - right.seq)
        .map(({ assetId, intent, displayName }) => ({ assetId, intent, displayName }))
      if (
        (!hasMeaningfulItems(items) && attachments.length === 0) ||
        !sourceMessageId ||
        !sessionId
      )
        return

      const runtime = getSessionRuntime(current, sessionId)
      const edit: PendingPromptEdit =
        runtime.pendingPromptEdit?.sourceMessageId === sourceMessageId &&
        sameInputItems(runtime.pendingPromptEdit.items, items) &&
        sameAttachmentSnapshot(runtime.pendingPromptEdit.attachments, attachments)
          ? runtime.pendingPromptEdit
          : {
              id: globalThis.crypto.randomUUID(),
              sessionId,
              sourceMessageId,
              content: prompt,
              items,
              attachments,
            }

      replaceRuntime(sessionId, (currentRuntime) =>
        beginOperation(
          { ...currentRuntime, pendingPromptEdit: edit },
          {
            id: edit.id,
            kind: "edit-prompt",
            sessionId,
            target: sourceMessageId,
            startedAt: Date.now(),
          }
        )
      )
      try {
        await window.desktop.sessions.editLatestPrompt({
          id: edit.id,
          sessionId,
          items,
          sourceMessageId,
          attachments,
        })
        replaceRuntime(sessionId, (currentRuntime) =>
          removeOperation(
            currentRuntime.pendingPromptEdit?.id === edit.id
              ? { ...currentRuntime, pendingPromptEdit: null }
              : currentRuntime,
            edit.id
          )
        )
      } catch (error) {
        const message = errorMessage(error)
        const confirmed = !getSessionRuntime(get(), sessionId).pendingPromptEdit
        replaceRuntime(sessionId, (currentRuntime) =>
          confirmed
            ? removeOperation(currentRuntime, edit.id)
            : failOperation(currentRuntime, edit.id, message, Date.now())
        )
        if (!confirmed) throw error
      } finally {
        context.scheduleSelectedProjectGitRefresh(true)
      }
    },

    async interrupt(target) {
      const sessionId = target?.sessionId ?? get().activeSessionId
      if (!sessionId) return
      const view = target ? target.view : get().sessionView
      const expectedRunId =
        view?.session.id === sessionId
          ? (view.runs.find((run) => run.status === "running")?.id ??
            view.runs.find((run) => run.status === "pending")?.id)
          : undefined
      const alreadyPending = Object.values(getSessionRuntime(get(), sessionId).operations).some(
        (operation) =>
          operation.kind === "interrupt-run" &&
          operation.target === expectedRunId &&
          operation.phase === "pending"
      )
      if (alreadyPending) return
      const operationId = globalThis.crypto.randomUUID()
      replaceRuntime(sessionId, (runtime) =>
        beginOperation(runtime, {
          id: operationId,
          kind: "interrupt-run",
          sessionId,
          target: expectedRunId,
          startedAt: Date.now(),
        })
      )
      try {
        await window.desktop.sessions.interrupt({
          sessionId,
          ...(expectedRunId ? { expectedRunId } : {}),
        })
        if (!get().sessionRuntimes[sessionId]) return
        // A targeted stop remains pending until the session stream confirms that run ended.
        if (!expectedRunId)
          replaceRuntime(sessionId, (runtime) => removeOperation(runtime, operationId))
      } catch (error) {
        if (!get().sessionRuntimes[sessionId]) return
        const message = errorMessage(error)
        const confirmed = !getSessionRuntime(get(), sessionId).operations[operationId]
        replaceRuntime(sessionId, (runtime) =>
          confirmed
            ? removeOperation(runtime, operationId)
            : failOperation(runtime, operationId, message, Date.now())
        )
      }
    },

    async replyPermission(permissionId, status, decision = "once", answer, targetSessionId) {
      const sessionId = targetSessionId ?? get().activeSessionId
      if (!sessionId || !permissionId) return
      const operationId = `${sessionId}:${permissionId}`
      if (getSessionRuntime(get(), sessionId).operations[operationId]?.phase === "pending") return
      replaceRuntime(sessionId, (runtime) =>
        beginOperation(runtime, {
          id: operationId,
          kind: "reply-permission",
          sessionId,
          target: permissionId,
          startedAt: Date.now(),
        })
      )
      try {
        await window.desktop.sessions.replyPermission({
          permissionId,
          status,
          decision,
          ...(answer !== undefined ? { answer } : {}),
        })
        if (!get().sessionRuntimes[sessionId]) return
        replaceRuntime(sessionId, (runtime) => removeOperation(runtime, operationId))
      } catch (error) {
        if (!get().sessionRuntimes[sessionId]) return
        const message = errorMessage(error)
        const confirmed = !getSessionRuntime(get(), sessionId).operations[operationId]
        replaceRuntime(sessionId, (runtime) =>
          confirmed
            ? removeOperation(runtime, operationId)
            : failOperation(runtime, operationId, message, Date.now())
        )
      }
    },
  }

  function replaceRuntime(
    sessionId: string,
    update: (runtime: DesktopSessionRuntime) => DesktopSessionRuntime
  ): void {
    set((state) => {
      const runtime = update(getSessionRuntime(state, sessionId))
      const next = {
        sessionRuntimes: { ...state.sessionRuntimes, [sessionId]: runtime },
      }
      return next
    })
  }
}

function sameAttachmentSnapshot(
  left: readonly { assetId: string }[],
  right: readonly { assetId: string }[]
): boolean {
  return (
    left.length === right.length &&
    left.every((attachment, index) => attachment.assetId === right[index]?.assetId)
  )
}

function sameInputItems(
  left: readonly import("@shared/session-types").SessionUserInputItem[],
  right: readonly import("@shared/session-types").SessionUserInputItem[]
): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function hasMeaningfulItems(
  items: readonly import("@shared/session-types").SessionUserInputItem[]
): boolean {
  return items.some((item) => item.type !== "text" || item.text.trim().length > 0)
}

function getSessionRuntime(
  state: Pick<import("./types").DesktopSessionState, "sessionRuntimes">,
  sessionId: string
): DesktopSessionRuntime {
  return state.sessionRuntimes[sessionId] ?? createEmptySessionRuntime()
}

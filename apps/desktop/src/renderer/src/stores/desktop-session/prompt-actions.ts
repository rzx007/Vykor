import { errorMessage } from "./error-state"
import {
  acknowledgeOperation,
  beginOperation,
  createEmptySessionRuntime,
  failOperation,
  removeOperation,
} from "./operation-state"
import {
  classifyPromptPlacement,
  removePendingPromptSubmission,
  updatePendingPromptSubmission,
} from "./pending-prompt-state"
import type {
  DesktopSessionRuntime,
  DesktopStoreContext,
  PendingPromptEdit,
  PendingPromptSubmission,
  PromptActions,
} from "./types"
import {
  removeDraftAttachment,
  selectDraftDocument,
  sessionComposerScope,
  setDraftDocument,
} from "./composer-draft-state"
import {
  composerDocument,
  emptyComposerDocument,
  sameComposerDocument,
  selectComposerDocumentText,
} from "./composer-document"

interface PromptActionsContext extends DesktopStoreContext {
  scheduleSelectedProjectGitRefresh: (force: boolean) => void
}

export function createPromptActions(context: PromptActionsContext): PromptActions {
  const { get, set } = context

  return {
    dismissPromptSubmission(inputId) {
      const sessionId = get().activeSessionId
      if (!sessionId) return
      replaceRuntime(sessionId, (runtime) =>
        removeOperation(
          {
            ...runtime,
            pendingPromptSubmissions: removePendingPromptSubmission(
              runtime.pendingPromptSubmissions,
              inputId
            ),
          },
          inputId
        )
      )
    },
    async sendMessage(content, options) {
      const document = options?.document ?? composerDocument([{ type: "text", text: content }])
      const items = document.items
      const prompt = selectComposerDocumentText(document)
      const sessionId = get().activeSessionId
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
        (!hasMeaningfulItems(items) && attachments.length === 0)
      ) {
        return
      }

      const current = get()
      const runtime = getSessionRuntime(current, sessionId)
      const retry = Object.values(runtime.pendingPromptSubmissions).find(
        (submission) =>
          submission.content === prompt &&
          submission.phase === "failed" &&
          sameInputItems(submission.items, items) &&
          sameAttachmentSnapshot(submission.attachments, attachments)
      )
      const submission: PendingPromptSubmission = retry
        ? { ...retry, phase: "submitting", error: undefined }
        : {
            id: globalThis.crypto.randomUUID(),
            sessionId,
            content: prompt,
            items,
            attachments,
            createdAt: Date.now(),
            phase: "submitting",
            placement: classifyPromptPlacement(current.sessionView, runtime, sessionId),
          }

      replaceRuntime(sessionId, (currentRuntime) =>
        beginOperation(
          {
            ...currentRuntime,
            pendingPromptSubmissions: {
              ...currentRuntime.pendingPromptSubmissions,
              [submission.id]: submission,
            },
          },
          {
            id: submission.id,
            kind: "send-prompt",
            sessionId,
            startedAt: Date.now(),
          }
        )
      )

      try {
        await window.desktop.sessions.sendPrompt({
          id: submission.id,
          sessionId,
          items,
          attachments: attachments.map(({ assetId, intent, displayName }) => ({
            assetId,
            intent,
            displayName,
          })),
        })
        clearSubmittedDraft(sessionId, document, attachmentDrafts)
        const keepLocalAcknowledgement = get().activeSessionId === sessionId
        replaceRuntime(sessionId, (currentRuntime) =>
          settleSubmittedPrompt(
            {
              ...currentRuntime,
              pendingPromptSubmissions: updatePendingPromptSubmission(
                currentRuntime.pendingPromptSubmissions,
                submission.id,
                (pendingSubmission) => ({
                  ...pendingSubmission,
                  phase: "accepted",
                  error: undefined,
                })
              ),
            },
            submission.id,
            keepLocalAcknowledgement
          )
        )
      } catch (error) {
        const message = errorMessage(error)
        const confirmed = promptSubmissionConfirmed(get(), sessionId, submission.id)
        const keepLocalAcknowledgement = get().activeSessionId === sessionId
        if (confirmed) clearSubmittedDraft(sessionId, document, attachmentDrafts)
        replaceRuntime(sessionId, (currentRuntime) => {
          if (confirmed) {
            const acceptedSubmissions = updatePendingPromptSubmission(
              currentRuntime.pendingPromptSubmissions,
              submission.id,
              (pendingSubmission) => ({
                ...pendingSubmission,
                phase: "accepted",
                error: undefined,
              })
            )
            return removeOperation(
              {
                ...currentRuntime,
                pendingPromptSubmissions: keepLocalAcknowledgement
                  ? acceptedSubmissions
                  : removePendingPromptSubmission(acceptedSubmissions, submission.id),
              },
              submission.id
            )
          }
          return failOperation(
            {
              ...currentRuntime,
              pendingPromptSubmissions: updatePendingPromptSubmission(
                currentRuntime.pendingPromptSubmissions,
                submission.id,
                (pendingSubmission) => ({ ...pendingSubmission, phase: "failed", error: message })
              ),
            },
            submission.id,
            message,
            Date.now()
          )
        })
        if (!confirmed) throw error
      } finally {
        context.scheduleSelectedProjectGitRefresh(true)
      }
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

    async interrupt() {
      const sessionId = get().activeSessionId
      if (!sessionId) return
      const view = get().sessionView
      const expectedRunId =
        view?.session.id === sessionId
          ? (view.runs.find((run) => run.status === "running")?.id ??
            view.runs.find((run) => run.status === "pending")?.id)
          : undefined
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
        replaceRuntime(sessionId, (runtime) => removeOperation(runtime, operationId))
      } catch (error) {
        const message = errorMessage(error)
        const confirmed = !getSessionRuntime(get(), sessionId).operations[operationId]
        replaceRuntime(sessionId, (runtime) =>
          confirmed
            ? removeOperation(runtime, operationId)
            : failOperation(runtime, operationId, message, Date.now())
        )
      }
    },

    async replyPermission(permissionId, status, decision = "once", answer) {
      const sessionId = get().activeSessionId
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
        replaceRuntime(sessionId, (runtime) => removeOperation(runtime, operationId))
      } catch (error) {
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

  function clearSubmittedDraft(
    sessionId: string,
    submittedDocument: import("./composer-document").ComposerDocument,
    submitted: readonly { draftId: string; assetId?: string }[]
  ): void {
    const scope = sessionComposerScope(sessionId)
    set((state) => {
      let composerState = { composerDraftsByScope: state.composerDraftsByScope }
      for (const attachment of submitted) {
        const current = composerState.composerDraftsByScope[scope]?.attachments.find(
          (candidate) => candidate.draftId === attachment.draftId
        )
        if (current?.status === "ready" && current.assetId === attachment.assetId) {
          composerState = removeDraftAttachment(composerState, scope, attachment.draftId)
        }
      }
      const currentDocument = selectDraftDocument(composerState, scope)
      return {
        ...state,
        ...setDraftDocument(
          composerState,
          scope,
          sameComposerDocument(currentDocument, submittedDocument)
            ? emptyComposerDocument
            : currentDocument
        ),
      }
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

function promptSubmissionConfirmed(
  state: Pick<import("./types").DesktopSessionState, "sessionRuntimes" | "sessionView">,
  sessionId: string,
  inputId: string
): boolean {
  const submission = getSessionRuntime(state, sessionId).pendingPromptSubmissions[inputId]
  return (
    !submission ||
    submission.phase === "accepted" ||
    Boolean(
      state.sessionView?.session.id === sessionId &&
      state.sessionView.inputs.some((input) => input.id === inputId)
    )
  )
}

function settleSubmittedPrompt(
  runtime: DesktopSessionRuntime,
  submissionId: string,
  keepLocalAcknowledgement: boolean
): DesktopSessionRuntime {
  const acknowledged = acknowledgeOperation(runtime, submissionId, Date.now())
  if (keepLocalAcknowledgement) return acknowledged
  return removeOperation(
    {
      ...acknowledged,
      pendingPromptSubmissions: removePendingPromptSubmission(
        acknowledged.pendingPromptSubmissions,
        submissionId
      ),
    },
    submissionId
  )
}

import type { CreateDesktopSessionInput } from "@shared/session-types"
import { errorMessage } from "./error-state"
import { formatSessionTitle, upsertSession } from "./helpers"
import {
  acknowledgeOperation,
  beginOperation,
  bindOperationToSession,
  createEmptySessionRuntime,
  failOperation,
} from "./operation-state"
import { settlePromptSubmission } from "./prompt-submission"
import {
  migrateComposerScope,
  NEW_CONVERSATION_SCOPE,
  sessionComposerScope,
} from "./composer-draft-state"
import { composerDocument, selectComposerDocumentText } from "./composer-document"
import type { DesktopStoreContext, PendingPromptSubmission, SessionActions } from "./types"

interface StartSessionContext extends DesktopStoreContext {
  scheduleSelectedProjectGitRefresh: (force: boolean) => void
}

export function createStartSessionAction(
  context: StartSessionContext,
  controls: {
    navigationGeneration: () => number
    advancePrimaryNavigation: () => number
    openPrimarySession: (sessionId: string) => Promise<"applied" | "cancelled" | "failed">
  }
): SessionActions["startSession"] {
  const { get, set } = context

  return async (content, options) => {
    if (get().pendingModeChanges.new) return null
    const document = options?.document ?? composerDocument([{ type: "text", text: content }])
    const items = document.items
    const prompt = selectComposerDocumentText(document)
    const attachmentDrafts = [...(options?.attachments ?? [])]
    if (attachmentDrafts.some((attachment) => attachment.status !== "ready")) return null
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
    if (attachments.length !== attachmentDrafts.length) return null
    const {
      selectedProject,
      workspaceMode,
      selectedModel,
      selectedProvider,
      defaultModel,
      defaultProvider,
      selectedPermissionMode,
      selectedWorkMode,
      selectedEffort,
    } = get()
    const model = selectedModel ?? defaultModel
    const provider = selectedProvider ?? defaultProvider
    if (
      (!hasMeaningfulItems(items) && attachments.length === 0) ||
      Object.values(get().newConversationRuntime.operations).some(
        (operation) => operation.kind === "create-session" && operation.phase === "pending"
      )
    )
      return null
    if (workspaceMode === "project" && !selectedProject) {
      return null
    }
    if (!model) {
      return null
    }

    const promptSubmissionId = globalThis.crypto.randomUUID()
    const navigationOwnerGeneration = controls.navigationGeneration()
    const createOperation = {
      id: promptSubmissionId,
      kind: "create-session" as const,
      sessionId: null,
      startedAt: Date.now(),
    }
    let startedSessionId: string | null = null
    let pendingSubmission: PendingPromptSubmission | null = null
    set((state) => {
      const newConversationRuntime = beginOperation(state.newConversationRuntime, createOperation)
      return {
        newConversationRuntime,
      }
    })
    try {
      const sessionInput: CreateDesktopSessionInput =
        workspaceMode === "project" && selectedProject
          ? {
              projectId: selectedProject.id,
              ...(options?.taskLocation ? { taskLocation: options.taskLocation } : {}),
              cwd: selectedProject.path,
              model,
              ...(provider ? { provider } : {}),
              permissionMode: selectedPermissionMode,
              workMode: selectedWorkMode,
              ...(selectedEffort ? { effort: selectedEffort } : {}),
            }
          : {
              model,
              ...(provider ? { provider } : {}),
              permissionMode: selectedPermissionMode,
              workMode: selectedWorkMode,
              ...(selectedEffort ? { effort: selectedEffort } : {}),
            }
      // 创建会话
      const session = await window.desktop.sessions.create(sessionInput)
      startedSessionId = session.id
      // 创建第一个提交
      const firstSubmission: PendingPromptSubmission = {
        id: promptSubmissionId,
        sessionId: session.id,
        content: prompt,
        items,
        draftDocument: document,
        draftAttachmentIds: attachmentDrafts.map((attachment) => attachment.draftId),
        attachments,
        createdAt: Date.now(),
        phase: "submitting",
        placement: "transcript",
      }
      pendingSubmission = firstSubmission
      // 判断是否拥有当前页面
      let ownsCurrentPage = false
      set((state) => {
        const ownsNewConversationRuntime =
          state.newConversationRuntime.operations[promptSubmissionId]?.phase === "pending"
        ownsCurrentPage =
          navigationOwnerGeneration === controls.navigationGeneration() &&
          ownsNewConversationRuntime
        if (ownsCurrentPage) controls.advancePrimaryNavigation()
        const bound = ownsNewConversationRuntime
          ? bindOperationToSession(
              state.newConversationRuntime,
              state.sessionRuntimes[session.id] ?? createEmptySessionRuntime(),
              promptSubmissionId,
              session.id
            )
          : {
              source: state.newConversationRuntime,
              target: bindOperationToSession(
                beginOperation(createEmptySessionRuntime(), createOperation),
                state.sessionRuntimes[session.id] ?? createEmptySessionRuntime(),
                promptSubmissionId,
                session.id
              ).target,
            }
        const runtime = {
          ...bound.target,
          pendingPromptSubmissions: {
            ...bound.target.pendingPromptSubmissions,
            [promptSubmissionId]: firstSubmission,
          },
        }
        const acknowledgedRuntime = acknowledgeOperation(runtime, promptSubmissionId, Date.now())
        const composerState = ownsNewConversationRuntime
          ? migrateComposerScope(
              { composerDraftsByScope: state.composerDraftsByScope },
              NEW_CONVERSATION_SCOPE,
              sessionComposerScope(session.id)
            )
          : { composerDraftsByScope: state.composerDraftsByScope }
        return {
          sessions: upsertSession(state.sessions, session),
          newConversationRuntime: bound.source,
          sessionRuntimes: {
            ...state.sessionRuntimes,
            [session.id]: acknowledgedRuntime,
          },
          ...composerState,
          ...(ownsCurrentPage
            ? {
                activeSessionId: session.id,
              }
            : {}),
        }
      })
      const openResult = ownsCurrentPage
        ? await controls.openPrimarySession(session.id)
        : "cancelled"
      if (openResult === "failed") {
        const openError = Object.values(get().sessionRuntimes[session.id]?.operations ?? {}).find(
          (operation) => operation.kind === "open-session" && operation.phase === "failed"
        )
        throw new Error(openError?.error ?? "无法打开新会话")
      }
      // Switching pages keeps the runtime; confirmed deletion removes it.
      if (!get().sessionRuntimes[session.id]) return null
      await get().submitPromptSubmission(firstSubmission)
      // 设置会话标题
      const title = prompt
        ? formatSessionTitle(prompt)
        : [...(attachments[0]?.displayName || "新对话")].slice(0, 20).join("")
      set((state) => {
        if (!state.sessions.some((candidate) => candidate.id === session.id)) return state
        const titledSession = { ...session, title, updatedAt: Date.now() }
        return {
          sessions: upsertSession(state.sessions, titledSession),
          sessionView:
            state.sessionView?.session.id === session.id
              ? {
                  ...state.sessionView,
                  session: { ...state.sessionView.session, title },
                }
              : state.sessionView,
        }
      })
    } catch (error) {
      const message = errorMessage(error)
      const confirmed = pendingSubmission
        ? settlePromptSubmission(context, pendingSubmission, message)
        : false
      if (!startedSessionId) {
        set((state) => ({
          newConversationRuntime: failOperation(
            state.newConversationRuntime,
            promptSubmissionId,
            message,
            Date.now()
          ),
        }))
      }
      if (confirmed) return startedSessionId
      throw error
    } finally {
      context.scheduleSelectedProjectGitRefresh(true)
    }
    return startedSessionId
  }
}

function hasMeaningfulItems(
  items: readonly import("@shared/session-types").SessionUserInputItem[]
): boolean {
  return items.some((item) => item.type !== "text" || item.text.trim().length > 0)
}

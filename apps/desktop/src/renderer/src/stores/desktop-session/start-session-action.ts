import type { CreateDesktopSessionInput, DesktopSessionView } from "@shared/session-types"
import type { DesktopAttachmentDraft } from "@shared/attachment-types"
import { errorMessage } from "./error-state"
import { formatSessionTitle, upsertSession } from "./helpers"
import { acknowledgeOperation, beginOperation, bindOperationToSession, createEmptySessionRuntime, failOperation, removeOperation } from "./operation-state"
import { removePendingPromptSubmission, updatePendingPromptSubmission } from "./pending-prompt-state"
import { migrateComposerScope, NEW_CONVERSATION_SCOPE, sessionComposerScope } from "./composer-draft-state"
import { composerDocument, emptyComposerDocument, sameComposerDocument, selectComposerDocumentText, type ComposerDocument } from "./composer-document"
import type { DesktopSessionRuntime, DesktopStoreContext, PendingPromptSubmission, SessionActions } from "./types"

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
    let clearedFirstPromptDraft = false
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
              ...(selectedEffort ? { effort: selectedEffort } : {}),
            }
          : {
              model,
              ...(provider ? { provider } : {}),
              permissionMode: selectedPermissionMode,
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
        attachments,
        createdAt: Date.now(),
        phase: "submitting",
        placement: "transcript",
      }
      // 判断是否拥有当前页面
      let ownsCurrentPage = false
      set((state) => {
        const ownsNewConversationRuntime =
          state.newConversationRuntime.operations[promptSubmissionId]?.phase === "pending"
        ownsCurrentPage =
          navigationOwnerGeneration === controls.navigationGeneration() && ownsNewConversationRuntime
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
        clearedFirstPromptDraft = ownsNewConversationRuntime
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
      if (clearedFirstPromptDraft) {
        clearFirstPromptDraft(session.id, document, attachmentDrafts)
      }
      const openResult = ownsCurrentPage ? await controls.openPrimarySession(session.id) : "cancelled"
      if (openResult === "failed") {
        const openError = Object.values(get().sessionRuntimes[session.id]?.operations ?? {}).find(
          (operation) => operation.kind === "open-session" && operation.phase === "failed"
        )
        throw new Error(openError?.error ?? "无法打开新会话")
      }
      // 发送第一个提交
      await window.desktop.sessions.sendPrompt({
        id: promptSubmissionId,
        sessionId: session.id,
        items,
        attachments: attachments.map(({ assetId, intent, displayName }) => ({
          assetId,
          intent,
          displayName,
        })),
      })
      // 清除第一个提交的草稿
      clearFirstPromptDraft(session.id, document, attachmentDrafts)
      const keepLocalAcknowledgement = get().activeSessionId === session.id
      set((state) => {
        // 更新会话运行时
        const sessionRuntimes = updateSessionRuntime(
          state.sessionRuntimes,
          session.id,
          (runtime) => {
            const acceptedRuntime = {
              ...runtime,
              pendingPromptSubmissions: updatePendingPromptSubmission(
                runtime.pendingPromptSubmissions,
                promptSubmissionId,
                (submission) => ({ ...submission, phase: "accepted", error: undefined })
              ),
            }
            return keepLocalAcknowledgement
              ? acceptedRuntime
              : removeOperation(
                  {
                    ...acceptedRuntime,
                    pendingPromptSubmissions: removePendingPromptSubmission(
                      acceptedRuntime.pendingPromptSubmissions,
                      promptSubmissionId
                    ),
                  },
                  promptSubmissionId
                )
          }
        )
        return { sessionRuntimes }
      })
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
      const currentState = get()
      const currentSessionRuntime = startedSessionId
        ? currentState.sessionRuntimes[startedSessionId]
        : null
      const confirmed = Boolean(
        startedSessionId &&
        currentSessionRuntime &&
        (!currentSessionRuntime.pendingPromptSubmissions[promptSubmissionId] ||
          (currentState.activeSessionId === startedSessionId &&
            sessionViewContainsInput(currentState.sessionView, promptSubmissionId)))
      )
      set((state) => {
        const ownsNewConversation =
          navigationOwnerGeneration === controls.navigationGeneration() &&
          state.newConversationRuntime.operations[promptSubmissionId]?.phase === "pending"
        const sessionRuntimes = startedSessionId
          ? updateSessionRuntime(state.sessionRuntimes, startedSessionId, (runtime) => {
              return {
                ...runtime,
                pendingPromptSubmissions: confirmed
                  ? removePendingPromptSubmission(
                      runtime.pendingPromptSubmissions,
                      promptSubmissionId
                    )
                  : updatePendingPromptSubmission(
                      runtime.pendingPromptSubmissions,
                      promptSubmissionId,
                      (submission) => ({ ...submission, phase: "failed", error: message })
                    ),
              }
            })
          : state.sessionRuntimes
        const newConversationRuntime = ownsNewConversation
          ? failOperation(state.newConversationRuntime, promptSubmissionId, message, Date.now())
          : state.newConversationRuntime
        return {
          newConversationRuntime,
          sessionRuntimes,
        }
      })
      if (confirmed && startedSessionId) {
        clearFirstPromptDraft(startedSessionId, document, attachmentDrafts)
      } else if (startedSessionId && clearedFirstPromptDraft) {
        restoreFirstPromptDraft(startedSessionId, document, attachmentDrafts)
      }
      if (confirmed) return startedSessionId
      throw error
    } finally {
      context.scheduleSelectedProjectGitRefresh(true)
    }
    return startedSessionId
  }

  function clearFirstPromptDraft(
    sessionId: string,
    submittedDocument: ComposerDocument,
    submittedAttachments: readonly DesktopAttachmentDraft[]
  ): void {
    const scope = sessionComposerScope(sessionId)
    set((state) => {
      const current = state.composerDraftsByScope[scope]
      if (!current) return state
      const submittedByDraftId = new Map(
        submittedAttachments.map((attachment) => [attachment.draftId, attachment.assetId])
      )
      return {
        composerDraftsByScope: {
          ...state.composerDraftsByScope,
          [scope]: {
            document: sameComposerDocument(current.document, submittedDocument)
              ? emptyComposerDocument
              : current.document,
            attachments: current.attachments.filter(
              (attachment) =>
                submittedByDraftId.get(attachment.draftId) !== attachment.assetId ||
                attachment.status !== "ready"
            ),
          },
        },
      }
    })
  }

  function restoreFirstPromptDraft(
    sessionId: string,
    submittedDocument: ComposerDocument,
    submittedAttachments: readonly DesktopAttachmentDraft[]
  ): void {
    const scope = sessionComposerScope(sessionId)
    set((state) => {
      const current = state.composerDraftsByScope[scope] ?? {
        document: emptyComposerDocument,
        attachments: [],
      }
      const currentDraftIds = new Set(current.attachments.map((attachment) => attachment.draftId))
      return {
        composerDraftsByScope: {
          ...state.composerDraftsByScope,
          [scope]: {
            document: current.document.items.length === 0 ? submittedDocument : current.document,
            attachments: [
              ...submittedAttachments.filter(
                (attachment) => !currentDraftIds.has(attachment.draftId)
              ),
              ...current.attachments,
            ],
          },
        },
      }
    })
  }
}

function updateSessionRuntime(
  runtimes: Record<string, DesktopSessionRuntime>,
  sessionId: string,
  update: (runtime: DesktopSessionRuntime) => DesktopSessionRuntime
): Record<string, DesktopSessionRuntime> {
  const runtime = runtimes[sessionId]
  if (!runtime) return runtimes
  return { ...runtimes, [sessionId]: update(runtime) }
}

function sessionViewContainsInput(view: DesktopSessionView | null, inputId: string): boolean {
  return Boolean(view?.inputs.some((input) => input.id === inputId))
}

function hasMeaningfulItems(
  items: readonly import("@shared/session-types").SessionUserInputItem[]
): boolean {
  return items.some((item) => item.type !== "text" || item.text.trim().length > 0)
}

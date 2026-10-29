import { ConversationFind } from "./transcript/conversation-find"
import { submitConversationDraft } from "./session/submit-conversation-draft"
import { pluginAppModelContexts } from "../shell/plugin-apps/plugin-app-model-context"
import { MoreHorizontal, PanelRight } from "lucide-react"
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react"
import { useNavigate } from "@tanstack/react-router"

import { OpenWithSplitButton } from "@renderer/components/desktop/open-with"
import { SideChatSelectionActions } from "@renderer/components/desktop/tools/side-chat/side-chat-selection-actions"
import {
  ConversationScroller as MessageScroller,
  ConversationScrollerButton as MessageScrollerButton,
  ConversationScrollerContent as MessageScrollerContent,
  ConversationScrollerProvider as MessageScrollerProvider,
  ConversationScrollerViewport as MessageScrollerViewport,
} from "./transcript/conversation-scroller"
import { Spinner } from "@renderer/components/ui/spinner"
import { MessagePluginCatalog } from "./message/blocks/plugin-mention-icon"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@renderer/components/ui/select"
import { cn } from "@renderer/lib/utils"
import {
  areDesktopAttachmentsSendable,
  disabledDesktopAttachmentSupport,
} from "@shared/attachment-types"
import { useDesktopSessionStore } from "@renderer/stores/desktop-session"
import {
  NEW_CONVERSATION_SCOPE,
  selectDraftAttachments,
  selectDraftDocument,
  sessionComposerScope,
} from "@renderer/stores/desktop-session/composer-draft-state"
import {
  composerDocument,
  selectComposerDocumentText,
  type ComposerDocument,
} from "@renderer/stores/desktop-session/composer-document"
import {
  selectActiveSessionOpening,
  selectActiveSessionRecord,
  selectActiveSessionComposerError,
  selectActiveSessionPermissionReplies,
  selectActiveSessionPromptSubmissions,
  selectActiveSessionQueuedPromptActions,
  selectActiveSessionSending,
  selectCommandCatalogCwd,
  selectNewConversationError,
  selectNewConversationSending,
  selectActiveWorkspaceProject,
} from "@renderer/stores/desktop-session/selectors"
import { Composer } from "./composer/composer"
import { pluginMentionsEnabled } from "./composer/plugin-mentions-feature"
import { GoalBanner } from "./composer/goal-banner"
import {
  emptyGoalComposer,
  selectGoalObjective,
} from "@renderer/stores/desktop-session/goal-actions"
import { PendingPromptQueue } from "./transcript/pending-prompt-queue"
import {
  derivePendingHandoffSubmission,
  mergeOptimisticTranscript,
} from "./transcript/optimistic-transcript"
import type { ComposerPickerCommand } from "./composer/composer-picker"
import { toComposerCommands } from "./composer/composer-command-catalog"
import { toComposerSkills } from "./composer/composer-picker-model"
import type { ComposerSkill } from "./composer/rich-prompt-input"
import { HeaderIconButton } from "./composer/controls"
import { resolveEffortTiers } from "./composer/effort-picker"
import { isSessionPinned } from "@renderer/stores/desktop-session/helpers"
import { NewConversationStart } from "./session/new-conversation-start"
import { PermissionCard } from "./message/blocks/permission-card"
import { requiresPermissionReply } from "./message/blocks/permission-presentation"
import { AskUserCard } from "./message/blocks/ask-user-card"
import { isAskUserPermission } from "./message/blocks/ask-user-payload"
import { ProjectInfoButton } from "./session/project-info-popover"
import { SessionSummaryPopover } from "./session/session-summary-popover"
import { SessionMoreMenu } from "./session/session-more-menu"
import { useSessionActionDialogs } from "./session/session-action-dialogs"
import { ScopedOperationError } from "./session/scoped-operation-errors"
import { ConversationTranscriptSkeletonOverlay } from "./transcript/conversation-transcript-skeleton"
import { ConversationPreviewRail } from "./transcript/conversation-preview-rail"
import { ConversationTranscript } from "./transcript/transcript"
import { useShowReasoning } from "./shared/use-show-reasoning"
import { useTaskLocation } from "./session/use-task-location"
import { openConversationTextMenu } from "./shared/conversation-text-actions"
import type { AddToComposerEventDetail, ConversationPaneProps } from "./shared/types"
import { resolveScrollerAgentStatus } from "./transcript/scroller-agent-status"
import { resolveModelLabel } from "./shared/utils"

function ConversationPane({
  panelOpen,
  searchTarget,
  onSearchTargetConsumed,
  onTogglePanel,
  onOpenFile,
  canOpenReview,
  onOpenReview,
  onOpenTerminal,
  onOpenApps,
  onOpenAgents,
}: ConversationPaneProps): React.JSX.Element {
  const [composerValidationError, setComposerValidationError] = useState<string | null>(null)
  const [skillCommandSnapshot, setSkillCommandSnapshot] = useState<{
    cwd: string
    commands: import("@shared/session-types").DesktopCommandCatalogEntry[]
  } | null>(null)
  const [statusOpen, setStatusOpen] = useState(false)
  const [pluginSnapshot, setPluginSnapshot] = useState<{
    cwd: string
    plugins: import("@shared/session-types").DesktopPluginCatalogEntry[]
    error?: string
  } | null>(null)
  const navigate = useNavigate()
  const messageViewportRef = useRef<HTMLDivElement>(null)
  const activeSessionId = useDesktopSessionStore((state) => state.activeSessionId)
  const sessionView = useDesktopSessionStore((state) => state.sessionView)
  const activeSession = useDesktopSessionStore(selectActiveSessionRecord)
  const openingSession = useDesktopSessionStore(selectActiveSessionOpening)
  const activeSessionError = useDesktopSessionStore(selectActiveSessionComposerError)
  const newConversationError = useDesktopSessionStore(selectNewConversationError)
  const activeSessionSending = useDesktopSessionStore(selectActiveSessionSending)
  const newConversationSending = useDesktopSessionStore(selectNewConversationSending)
  const models = useDesktopSessionStore((state) => state.models)
  const selectedModel = useDesktopSessionStore((state) => state.selectedModel)
  const selectedProvider = useDesktopSessionStore((state) => state.selectedProvider)
  const selectedPermissionMode = useDesktopSessionStore((state) => state.selectedPermissionMode)
  const selectedWorkMode = useDesktopSessionStore((state) => state.selectedWorkMode)
  const modeChangePending = useDesktopSessionStore((state) =>
    Boolean(state.pendingModeChanges[state.activeSessionId ?? "new"])
  )
  const selectWorkMode = useDesktopSessionStore((state) => state.selectWorkMode)
  const updateSessionWorkMode = useDesktopSessionStore((state) => state.updateSessionWorkMode)
  const changeWorkMode = (mode: import("@shared/session-types").DesktopWorkMode): void => {
    if (activeSessionId) void updateSessionWorkMode(activeSessionId, mode).catch(() => {})
    else selectWorkMode(mode)
  }
  const selectedEffort = useDesktopSessionStore((state) => state.selectedEffort)
  const workspaceMode = useDesktopSessionStore((state) => state.workspaceMode)
  const selectedProject = useDesktopSessionStore((state) => state.selectedProject)
  const [taskLocation, setTaskLocation] = useTaskLocation(selectedProject?.id ?? null)
  const workspaceProject = useDesktopSessionStore(selectActiveWorkspaceProject)
  const selectedProjectGit = useDesktopSessionStore((state) => state.selectedProjectGit)
  const branch = useDesktopSessionStore((state) => state.branch)
  const branches = useDesktopSessionStore((state) => state.branches)
  const projects = useDesktopSessionStore((state) => state.projects)
  const sessions = useDesktopSessionStore((state) => state.sessions)
  const loadStatus = useDesktopSessionStore((state) => state.loadStatus)
  const daemonStatus = useDesktopSessionStore((state) => state.daemonStatus)
  const startSession = useDesktopSessionStore((state) => state.startSession)
  const submitGoal = useDesktopSessionStore((state) => state.submitGoal)
  const setGoalMode = useDesktopSessionStore((state) => state.setGoalMode)
  const setGoalAutoTurns = useDesktopSessionStore((state) => state.setGoalAutoTurns)
  const setGoalTokenBudget = useDesktopSessionStore((state) => state.setGoalTokenBudget)
  const refreshGoal = useDesktopSessionStore((state) => state.refreshGoal)
  const applyGoalAction = useDesktopSessionStore((state) => state.applyGoalAction)
  const dismissGoalError = useDesktopSessionStore((state) => state.dismissGoalError)
  const dismissGoalBanner = useDesktopSessionStore((state) => state.dismissGoalBanner)
  const sendMessage = useDesktopSessionStore((state) => state.sendMessage)
  const retryPromptSubmission = useDesktopSessionStore((state) => state.retryPromptSubmission)
  const dismissPromptSubmission = useDesktopSessionStore((state) => state.dismissPromptSubmission)
  const editLatestMessage = useDesktopSessionStore((state) => state.editLatestMessage)
  const promoteQueuedPrompt = useDesktopSessionStore((state) => state.promoteQueuedPrompt)
  const cancelQueuedPrompt = useDesktopSessionStore((state) => state.cancelQueuedPrompt)
  const queuedPromptActions = useDesktopSessionStore(selectActiveSessionQueuedPromptActions)
  const pendingPromptSubmissions = useDesktopSessionStore(selectActiveSessionPromptSubmissions)
  const permissionReplies = useDesktopSessionStore(selectActiveSessionPermissionReplies)
  const forkSession = useDesktopSessionStore((state) => state.forkSession)
  const startConversationFrom = useDesktopSessionStore((state) => state.startConversationFrom)
  const togglePinSession = useDesktopSessionStore((state) => state.togglePinSession)
  const chooseProject = useDesktopSessionStore((state) => state.chooseProject)
  const selectProject = useDesktopSessionStore((state) => state.selectProject)
  const selectOutsideProject = useDesktopSessionStore((state) => state.selectOutsideProject)
  const checkoutBranch = useDesktopSessionStore((state) => state.checkoutBranch)
  const createAndCheckoutBranch = useDesktopSessionStore((state) => state.createAndCheckoutBranch)
  const selectModel = useDesktopSessionStore((state) => state.selectModel)
  const selectPermissionMode = useDesktopSessionStore((state) => state.selectPermissionMode)
  const selectEffort = useDesktopSessionStore((state) => state.selectEffort)
  const updateSessionModel = useDesktopSessionStore((state) => state.updateSessionModel)
  const updateSessionPermissionMode = useDesktopSessionStore(
    (state) => state.updateSessionPermissionMode
  )
  const updateSessionEffort = useDesktopSessionStore((state) => state.updateSessionEffort)
  const refreshContextUsage = useDesktopSessionStore((state) => state.refreshContextUsage)
  const resyncActiveSessionSnapshot = useDesktopSessionStore(
    (state) => state.resyncActiveSessionSnapshot
  )
  const resolveRunError = useCallback(
    async (action: "providers" | "input" | "refresh") => {
      if (action === "providers")
        await navigate({ to: "/settings/$section", params: { section: "providers" } })
      else if (action === "refresh") await resyncActiveSessionSnapshot({ throwOnError: true })
      else document.getElementById("message-composer")?.focus()
    },
    [navigate, resyncActiveSessionSnapshot]
  )
  const contextUsageSnapshot = useDesktopSessionStore((state) => state.contextUsageSnapshot)
  const interrupt = useDesktopSessionStore((state) => state.interrupt)
  const replyPermission = useDesktopSessionStore((state) => state.replyPermission)
  const setComposerDraftDocument = useDesktopSessionStore((state) => state.setComposerDraftDocument)
  const pickAttachmentFiles = useDesktopSessionStore((state) => state.pickAttachmentFiles)
  const addDroppedAttachments = useDesktopSessionStore((state) => state.addDroppedAttachments)
  const addClipboardAttachment = useDesktopSessionStore((state) => state.addClipboardAttachment)
  const cancelAttachment = useDesktopSessionStore((state) => state.cancelAttachment)
  const retryAttachment = useDesktopSessionStore((state) => state.retryAttachment)
  const removeAttachment = useDesktopSessionStore((state) => state.removeAttachment)
  const attachmentSupport = useDesktopSessionStore(
    (state) => state.attachmentSupport ?? disabledDesktopAttachmentSupport
  )
  const hasSession = activeSessionId !== null
  const composerScope = activeSessionId
    ? sessionComposerScope(activeSessionId)
    : NEW_CONVERSATION_SCOPE
  const draft = useDesktopSessionStore((state) => selectDraftDocument(state, composerScope))
  const attachments = useDesktopSessionStore((state) =>
    selectDraftAttachments(state, composerScope)
  )
  const attachmentPreparation = useDesktopSessionStore((state) => state.composerDraftsByScope[composerScope]?.attachmentPreparation)
  const draftText = selectComposerDocumentText(draft)
  const goal = useDesktopSessionStore((state) =>
    activeSessionId ? state.goalsBySession[activeSessionId] : null
  )
  const goalComposer = useDesktopSessionStore(
    (state) => state.goalComposersByScope[composerScope] ?? emptyGoalComposer
  )
  const goalMode = goalComposer.mode
  const goalBusy = goalComposer.busy
  const changeGoalMode = useCallback(
    (active: boolean) => setGoalMode(composerScope, active),
    [composerScope, setGoalMode]
  )
  const setDraft = useCallback(
    (next: ComposerDocument): void => {
      setComposerValidationError(null)
      setComposerDraftDocument(composerScope, next)
    },
    [composerScope, setComposerDraftDocument]
  )
  const sending = goalBusy || (hasSession ? activeSessionSending : newConversationSending)
  const showReasoning = useShowReasoning()
  const archived = sessionView?.session.status === "archived"
  const sessionActions = useSessionActionDialogs()

  const submitDraft = async (): Promise<void> => {
    const content = selectComposerDocumentText(draft)
    if (useDesktopSessionStore.getState().composerDraftsByScope[composerScope]?.attachmentPreparation?.pending.length) return
    const ready = areDesktopAttachmentsSendable(attachments)
    return submitConversationDraft(
      {
        sessionId: activeSessionId,
        content,
        attachmentCount: attachments.length,
        ready,
        blocked: sending || modeChangePending || Boolean(archived),
        goalMode,
      },
      async () => {
        setComposerValidationError(null)
        try {
          if (goalMode) {
            await submitGoal(composerScope)
            return
          }
          if (hasSession) {
            await sendMessage(content, { document: draft, attachments })
          } else {
            await startSession(content, {
              document: draft,
              attachments,
              ...(taskLocation !== "default" ? { taskLocation } : {}),
            })
          }
        } catch (error) {
          if (goalMode)
            setComposerValidationError(error instanceof Error ? error.message : String(error))
          // The store keeps the error and the draft stays available for retry.
        }
      }
    )
  }

  useEffect(() => {
    if (!activeSessionId) return
    void refreshGoal(activeSessionId)
    // Session events handle normal updates; recover a lost event while the view is open.
    const timer = window.setInterval(() => void refreshGoal(activeSessionId), 5_000)
    return () => window.clearInterval(timer)
  }, [activeSessionId, refreshGoal])

  const title = activeSession?.title.trim() || "新对话"
  const currentModel = sessionView?.session.model ?? selectedModel
  const modelLabel = resolveModelLabel(models, currentModel, selectedProvider)
  const running = Boolean(
    sessionView?.runs.some((run) => run.status === "pending" || run.status === "running") ||
    sessionView?.session.status === "running"
  )
  const activeRun = sessionView?.runs.find((run) => run.status === "running")
  const goalUserWorkPending =
    activeSessionSending ||
    Boolean(
      sessionView?.runs.some(
        (run) =>
          (run.status === "pending" || run.status === "running") &&
          (!run.metadata.goalRunKind || run.metadata.goalRunKind === "user")
      )
    )
  const pendingPrompts = (sessionView?.runs ?? [])
    .filter((run) => run.status === "pending" && run.inputId)
    .sort((left, right) => left.createdAt - right.createdAt)
    .flatMap((run) => {
      const input = sessionView?.inputs.find((candidate) => candidate.id === run.inputId)
      const action = queuedPromptActions[`${run.sessionId}:${run.id}`]
      return input ? [{ input, run, ...(action ? { action } : {}) }] : []
    })
  const pendingPermissions = sessionView?.permissions.filter(requiresPermissionReply) ?? []
  const singleAskUserPrompt =
    pendingPermissions.length === 1 && isAskUserPermission(pendingPermissions[0]!)
  const localPromptSubmissions = Object.values(pendingPromptSubmissions)
    .filter((submission) => submission.sessionId === activeSessionId)
    .sort((left, right) => left.createdAt - right.createdAt)
  const pendingHandoffSubmission = derivePendingHandoffSubmission(
    sessionView?.messages ?? [],
    sessionView?.inputs ?? [],
    sessionView?.runs ?? [],
    new Set(
      Object.values(queuedPromptActions)
        .filter((action) => action.phase !== "failed")
        .map((action) => action.runId)
    )
  )
  const transcriptSubmissions =
    pendingHandoffSubmission &&
    !localPromptSubmissions.some(
      (submission) =>
        submission.id === pendingHandoffSubmission.id && submission.placement === "transcript"
    )
      ? [...localPromptSubmissions, pendingHandoffSubmission]
      : localPromptSubmissions
  const transcript = mergeOptimisticTranscript(
    sessionView?.messages ?? [],
    sessionView?.parts ?? [],
    transcriptSubmissions
  )
  const scrollerAgentStatus = resolveScrollerAgentStatus({
    running,
    parts: sessionView?.parts ?? [],
    messages: sessionView?.messages,
    runs: sessionView?.runs,
    pendingPermissionCount: pendingPermissions.length,
    agentTaskRunning: sessionView?.tasks.some(
      (task) => task.type === "agent" && (task.status === "pending" || task.status === "running")
    ),
  })
  const commandCwd = useDesktopSessionStore(selectCommandCatalogCwd)
  const commandCatalog =
    commandCwd && skillCommandSnapshot?.cwd === commandCwd ? skillCommandSnapshot.commands : []
  const skillCommands: ComposerSkill[] = toComposerSkills(commandCatalog)
  const applicationCommands = toComposerCommands(commandCatalog, {
    hasSession: Boolean(activeSessionId && sessionView?.session.id === activeSessionId),
    running,
    canOpenReview,
    pinned: Boolean(activeSession && isSessionPinned(activeSession)),
    permissionMode: selectedPermissionMode,
    workMode: selectedWorkMode,
    hasModels: models.length > 0,
    hasEffortTiers: resolveEffortTiers(models, currentModel, selectedProvider).length > 0,
  })
  const pluginCatalog =
    pluginMentionsEnabled && pluginSnapshot?.cwd === commandCwd ? pluginSnapshot.plugins : []
  const pluginCatalogError =
    pluginMentionsEnabled && pluginSnapshot?.cwd === commandCwd
      ? (pluginSnapshot.error ?? null)
      : null
  const appContextEntries = useSyncExternalStore(
    pluginAppModelContexts.subscribe,
    pluginAppModelContexts.snapshot
  )
  const canSubmit =
    areDesktopAttachmentsSendable(attachments) &&
    Boolean(
      draftText.trim() ||
      attachments.length > 0 ||
      appContextEntries.some((entry) => entry.source.sessionId === activeSessionId)
    )

  const pasteAttachments = (files: readonly File[]): Promise<void> => {
    return useDesktopSessionStore.getState().addClipboardFiles(composerScope, files)
  }

  const pasteTextAttachment = (text: string): Promise<void> => {
    return addClipboardAttachment(composerScope, {
      bytes: new TextEncoder().encode(text).buffer as ArrayBuffer,
      displayName: "pasted-text.txt",
      mediaType: "text/plain",
    })
  }

  const copyAssistantMessage = useCallback(async (content: string): Promise<void> => {
    await window.desktop.clipboard.writeText(content)
  }, [])

  const forkFromAssistantMessage = useCallback(
    async (messageId: string): Promise<void> => {
      if (!activeSessionId || archived || running) return
      await forkSession(activeSessionId, { afterMessageId: messageId })
    },
    [activeSessionId, archived, running, forkSession]
  )

  const editLatestUserMessage = useCallback(
    async (sourceMessageId: string, document: ComposerDocument): Promise<void> => {
      if (archived || running || modeChangePending) return
      await editLatestMessage(sourceMessageId, selectComposerDocumentText(document), document)
    },
    [archived, running, modeChangePending, editLatestMessage]
  )

  useEffect(() => {
    const handleAddToComposer = (event: Event): void => {
      const detail = (event as CustomEvent<AddToComposerEventDetail>).detail
      if (!detail?.text) return
      if (detail.sessionId && detail.sessionId !== activeSessionId) return
      setDraft(composerDocument([...draft.items, { type: "text", text: detail.text }]))
      window.requestAnimationFrame(() => {
        const composer = document.querySelector<HTMLTextAreaElement>(
          "#message-composer, #new-conversation-composer"
        )
        composer?.focus()
      })
    }

    window.addEventListener("desktop:add-to-composer", handleAddToComposer)
    return () => window.removeEventListener("desktop:add-to-composer", handleAddToComposer)
  }, [activeSessionId, draft.items, setDraft])

  useEffect(() => {
    if (!commandCwd || loadStatus !== "ready") {
      return
    }

    let cancelled = false
    void window.desktop.sessions
      .listCommands(commandCwd)
      .then((commands) => {
        if (!cancelled) setSkillCommandSnapshot({ cwd: commandCwd, commands })
      })
      .catch(() => {
        if (!cancelled) setSkillCommandSnapshot({ cwd: commandCwd, commands: [] })
      })

    return () => {
      cancelled = true
    }
  }, [commandCwd, loadStatus])

  useEffect(() => {
    if (!pluginMentionsEnabled || !commandCwd || loadStatus !== "ready") return
    let cancelled = false
    void window.desktop.sessions.listContextPlugins(commandCwd).then(
      (plugins) => {
        if (!cancelled) setPluginSnapshot({ cwd: commandCwd, plugins })
      },
      () => {
        if (!cancelled)
          setPluginSnapshot({
            cwd: commandCwd,
            plugins: [],
            error: "插件列表暂时无法加载，请稍后重试。",
          })
      }
    )
    return () => {
      cancelled = true
    }
  }, [commandCwd, loadStatus])

  const executeComposerCommand = useCallback(
    async (command: ComposerPickerCommand): Promise<void> => {
      if (command.id === "compact") {
        if (!activeSessionId || running) throw new Error("当前会话无法压缩。")
        await window.desktop.sessions.compact({ sessionId: activeSessionId })
        await resyncActiveSessionSnapshot()
        void refreshContextUsage({ refresh: true })
        return
      }
      if (command.id === "status") {
        setStatusOpen(true)
        return
      }
      if (command.id === "goal") {
        changeGoalMode(true)
        return
      }
      if (command.id === "skills") {
        await navigate({ to: "/plugins" })
        return
      }
      if (command.id === "plan") {
        if (modeChangePending) throw new Error("模式正在保存，请稍后再试。")
        const mode = selectedWorkMode === "plan" ? "execute" : "plan"
        if (activeSessionId) await updateSessionWorkMode(activeSessionId, mode)
        else selectWorkMode(mode)
        return
      }
      if (command.id === "diff") {
        if (!canOpenReview) throw new Error("当前目录无法查看 Git 变更。")
        onOpenReview(undefined, "uncommitted")
        return
      }
      if (!activeSession) throw new Error("请先打开聊天。")
      if (command.id === "new") {
        await startConversationFrom(activeSession)
        if (!useDesktopSessionStore.getState().activeSessionId) await navigate({ to: "/" })
        return
      }
      if (command.id === "pin") {
        await togglePinSession(activeSession.id)
        return
      }
      if (command.id === "rename") {
        sessionActions.beginRename(activeSession)
        return
      }
      if (command.id === "fork") {
        if (running) throw new Error("请等待当前任务结束后再创建聊天分支。")
        const forked = await forkSession(activeSession.id)
        if (useDesktopSessionStore.getState().activeSessionId === forked.id) {
          await navigate({ to: "/conversation/$sessionId", params: { sessionId: forked.id } })
        }
        return
      }
      throw new Error(`暂不支持 /${command.id}。`)
    },
    [
      activeSessionId,
      changeGoalMode,
      navigate,
      refreshContextUsage,
      resyncActiveSessionSnapshot,
      running,
      activeSession,
      selectedWorkMode,
      updateSessionWorkMode,
      selectWorkMode,
      modeChangePending,
      canOpenReview,
      onOpenReview,
      startConversationFrom,
      togglePinSession,
      sessionActions,
      forkSession,
    ]
  )

  return (
    <MessagePluginCatalog.Provider value={pluginCatalog}>
      <section className="conversation-surface flex h-full min-w-0 flex-1 flex-col overflow-x-hidden bg-conversation">
        {hasSession ? (
          <header className="flex h-12 shrink-0 items-center border-b bg-background px-3">
            <div className="flex min-w-0 items-center gap-2">
              <ProjectInfoButton
                selectedProject={selectedProject}
                projects={projects}
                cwd={activeSession?.cwd ?? null}
                sessions={sessions}
              />
              <h1 className="text-ui-small truncate font-semibold">{title}</h1>
              {sessionView?.syncStatus === "reconnecting" ? (
                <span className="text-ui-caption flex shrink-0 items-center gap-1 text-ui-muted">
                  <Spinner className="size-3" />
                  正在重连
                </span>
              ) : null}
              {sessionView ? (
                <SessionMoreMenu
                  session={sessionView.session}
                  archived={archived}
                  onRename={() => sessionActions.beginRename(sessionView.session)}
                  onArchive={() => sessionActions.beginArchive(sessionView.session)}
                  onDelete={() => sessionActions.beginDelete(sessionView.session)}
                />
              ) : (
                <HeaderIconButton label="更多操作">
                  <MoreHorizontal />
                </HeaderIconButton>
              )}
            </div>

            <div className="ml-auto flex shrink-0 items-center gap-1">
              <OpenWithSplitButton folderPath={sessionView?.session.cwd ?? selectedProject?.path} />
              <SessionSummaryPopover
                onOpenApps={onOpenApps}
                onOpenTerminal={onOpenTerminal}
                view={sessionView?.session.id === activeSessionId ? sessionView : null}
                workspace={workspaceProject}
                canOpenReview={canOpenReview}
                onOpenReview={onOpenReview}
                onOpenAgents={onOpenAgents}
                onOpenFile={onOpenFile}
                onPickFiles={
                  attachmentSupport.interactionEnabled && !archived
                    ? () => pickAttachmentFiles(composerScope)
                    : undefined
                }
              />
              {!panelOpen && (
                <HeaderIconButton label="展开工具面板" onClick={onTogglePanel}>
                  <PanelRight />
                </HeaderIconButton>
              )}
            </div>
          </header>
        ) : null}

        {!hasSession ? (
          <NewConversationStart
            key={composerScope}
            draft={draft}
            sending={sending}
            loadStatus={loadStatus}
            daemonStatus={daemonStatus}
            projects={projects}
            selectedProject={selectedProject}
            workspaceMode={workspaceMode}
            selectedProjectGit={selectedProjectGit}
            branch={branch}
            branches={branches}
            models={models}
            selectedModel={selectedModel}
            selectedProvider={selectedProvider}
            selectedPermissionMode={selectedPermissionMode}
            workMode={selectedWorkMode}
            modeChangePending={modeChangePending}
            onWorkModeChange={changeWorkMode}
            effort={selectedEffort}
            operationError={composerValidationError ?? newConversationError ?? pluginCatalogError}
            goalError={goalComposer.error}
            onDismissGoalError={() => dismissGoalError(composerScope)}
            goalMode={goalMode}
            onGoalModeChange={changeGoalMode}
            goalAutoTurns={goalComposer.maxAutoTurns}
            onGoalAutoTurnsChange={(count) => setGoalAutoTurns(composerScope, count)}
            goalTokenBudget={goalComposer.tokenBudget}
            onGoalTokenBudgetChange={(value) => setGoalTokenBudget(composerScope, value)}
            commands={applicationCommands}
            onCommand={executeComposerCommand}
            skills={skillCommands}
            plugins={pluginCatalog}
            pluginMentionsEnabled={pluginMentionsEnabled}
            attachments={attachments}
            attachmentPreparation={attachmentPreparation}
            attachmentInteractionEnabled={attachmentSupport.interactionEnabled}
            panelOpen={panelOpen}
            onDraftChange={setDraft}
            onSubmit={() => void submitDraft()}
            onPickFiles={() => pickAttachmentFiles(composerScope)}
            onDropFiles={(files) => addDroppedAttachments(composerScope, files)}
            onPasteFiles={(files) => pasteAttachments(files)}
            onPasteTextAttachment={pasteTextAttachment}
            onCancelAttachment={(draftId) => cancelAttachment(composerScope, draftId)}
            onRetryAttachment={(draftId) => retryAttachment(composerScope, draftId)}
            onRemoveAttachment={(draftId) => {
              setComposerValidationError(null)
              return removeAttachment(composerScope, draftId)
            }}
            onChooseProject={() => void chooseProject()}
            onSelectProject={(project) => void selectProject(project)}
            onSelectOutsideProject={selectOutsideProject}
            onCheckoutBranch={checkoutBranch}
            onCreateAndCheckoutBranch={createAndCheckoutBranch}
            onSelectModel={(model) => void selectModel(model)}
            onSelectPermissionMode={(permissionMode) => void selectPermissionMode(permissionMode)}
            onSelectEffort={(effort) => {
              if (activeSessionId) void updateSessionEffort(activeSessionId, effort)
              else selectEffort(effort)
            }}
            onTogglePanel={onTogglePanel}
            contextUsage={contextUsageSnapshot}
            onOpenContextUsage={() => void refreshContextUsage({ refresh: true })}
          />
        ) : (
          <>
            <div className="relative min-h-0 min-w-0 flex-1">
              <MessageScrollerProvider
                key={`${activeSessionId ?? "new-session"}:${sessionView?.session.id === activeSessionId ? "ready" : "loading"}`}
              >
                <MessageScroller
                  className={cn(
                    "min-h-0 min-w-0 flex-1",
                    sessionView && "animate-in duration-200 fade-in-0 motion-reduce:animate-none"
                  )}
                >
                  <ConversationFind messages={transcript.messages} parts={transcript.parts}
                    target={searchTarget?.sessionId === sessionView?.session.id && !openingSession ? searchTarget : undefined}
                    onTargetConsumed={onSearchTargetConsumed} />
                  <MessageScrollerViewport
                    ref={messageViewportRef}
                    onContextMenu={(event) => void openConversationTextMenu(event)}
                    className="overflow-x-hidden"
                  >
                    <MessageScrollerContent className="conversation-content-column min-h-full min-w-0 text-content-foreground">
                      {openingSession && !sessionView ? null : (
                        <ConversationTranscript
                          tasks={sessionView?.tasks}
                          onRunErrorAction={resolveRunError}
                          onOpenAgents={onOpenAgents}
                          inputs={sessionView?.inputs ?? []}
                          messages={transcript.messages}
                          parts={transcript.parts}
                          runs={sessionView?.runs ?? []}
                          running={running}
                          canEditLastUserMessage={
                            !archived && !running && !sending && !modeChangePending
                          }
                          onEditLastUserMessage={editLatestUserMessage}
                          onCopyAssistantMessage={copyAssistantMessage}
                          onForkAssistantMessage={forkFromAssistantMessage}
                          onOpenFile={onOpenFile}
                          canOpenReview={canOpenReview}
                          onOpenReview={onOpenReview}
                          onOpenTerminal={onOpenTerminal}
                          showReasoning={showReasoning}
                          pendingPermissionCount={pendingPermissions.length}
                        />
                      )}
                    </MessageScrollerContent>
                  </MessageScrollerViewport>
                  <MessageScrollerButton className="bottom-5" status={scrollerAgentStatus} />
                </MessageScroller>
                <ConversationPreviewRail
                  messages={transcript.messages}
                  parts={transcript.parts}
                  runs={sessionView?.runs ?? []}
                  showReasoning={showReasoning}
                />
              </MessageScrollerProvider>
              <ConversationTranscriptSkeletonOverlay
                key={activeSessionId}
                loading={openingSession && !sessionView}
              />
              <SideChatSelectionActions
                sourceId={activeSessionId}
                viewportRef={messageViewportRef}
              />
            </div>

            {!archived && pendingPermissions.length > 0 ? (
              <div
                role="region"
                aria-label="待处理的授权请求"
                className={cn(
                  "conversation-composer-column mb-2 shrink-0",
                  singleAskUserPrompt
                    ? "overflow-visible"
                    : "max-h-[min(18rem,35vh)] scrollbar-thin overflow-y-auto"
                )}
              >
                <div className="space-y-2">
                  {pendingPermissions.map((permission) =>
                    isAskUserPermission(permission) ? (
                      <AskUserCard
                        key={`${permission.id}:${permissionReplies[permission.id]?.error ?? "active"}`}
                        permission={permission}
                        replyPending={permissionReplies[permission.id]?.pending}
                        replyError={permissionReplies[permission.id]?.error}
                        onReply={(answer) =>
                          void replyPermission(permission.id, "approved", "once", answer)
                        }
                      />
                    ) : (
                      <PermissionCard
                        key={permission.id}
                        permission={permission}
                        className="mt-0"
                        replyPending={permissionReplies[permission.id]?.pending}
                        replyError={permissionReplies[permission.id]?.error}
                        onReply={(status, decision) =>
                          void replyPermission(permission.id, status, decision)
                        }
                      />
                    )
                  )}
                </div>
              </div>
            ) : null}

            {archived ? (
              <div className="conversation-composer-column mb-5 flex h-12 shrink-0 items-center justify-center rounded-lg border border-border bg-background/90 text-xs text-muted-foreground shadow-sm">
                {"此会话已归档，只能查看历史内容"}
              </div>
            ) : (
              <div className="conversation-composer-column mb-5 flex shrink-0 flex-col gap-2">
                {goal && goalComposer.dismissedGoalId !== goal.id ? (
                  <GoalBanner
                    key={`${goal.id}:${goal.wait?.kind === "user" ? goal.wait.questionId : ""}`}
                    goal={goal}
                    busy={goalBusy}
                    userWorkPending={goalUserWorkPending}
                    editing={goalMode && Boolean(goalComposer.editingGoal)}
                    stopping={Boolean(goal.currentRunId && goal.status === "paused" && running)}
                    onEdit={() => changeGoalMode(true)}
                    onDismiss={() => dismissGoalBanner(composerScope, goal.id)}
                    onAction={(input) => {
                      if (activeSessionId) void applyGoalAction(activeSessionId, input)
                    }}
                  />
                ) : null}
                <ScopedOperationError
                  error={goalComposer.error}
                  onDismiss={() => dismissGoalError(composerScope)}
                />
                <ScopedOperationError
                  key={`error:${composerScope}`}
                  error={composerValidationError ?? activeSessionError ?? pluginCatalogError}
                />
                <PendingPromptQueue
                  prompts={pendingPrompts}
                  activeRunId={activeRun?.id}
                  localSubmissions={localPromptSubmissions}
                  onPromote={(inputId, queuedRunId) => {
                    if (activeRun) void promoteQueuedPrompt(inputId, queuedRunId, activeRun.id)
                  }}
                  onCancel={(inputId, queuedRunId) => void cancelQueuedPrompt(inputId, queuedRunId)}
                  onRetryLocal={(inputId) => {
                    void retryPromptSubmission(inputId).catch(() => undefined)
                  }}
                  onDismissLocal={dismissPromptSubmission}
                />
                {!hasSession && selectedProject && !goalMode ? (
                  <div className="mb-3 flex flex-wrap items-center gap-3">
                    <label htmlFor="new-task-location" className="text-sm text-muted-foreground">
                      任务工作位置
                    </label>
                    <Select
                      items={[
                        { value: "default", label: "按 Git 设置" },
                        { value: "current", label: "当前目录" },
                        { value: "worktree", label: "独立工作目录" },
                      ]}
                      value={taskLocation}
                      onValueChange={(value) => {
                        if (value === "default" || value === "current" || value === "worktree")
                          setTaskLocation(value)
                      }}
                    >
                      <SelectTrigger id="new-task-location" disabled={sending} className="w-auto">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          <SelectItem value="default">按 Git 设置</SelectItem>
                          <SelectItem value="current">当前目录</SelectItem>
                          <SelectItem value="worktree" disabled={!selectedProjectGit}>
                            独立工作目录
                          </SelectItem>
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </div>
                ) : null}
                <Composer
                  key={composerScope}
                  id="message-composer"
                  draft={draft}
                  sending={sending}
                  running={Boolean(activeRun)}
                  models={models}
                  selectedModel={currentModel}
                  selectedProvider={selectedProvider}
                  modelLabel={modelLabel}
                  permissionMode={selectedPermissionMode}
                  workMode={selectedWorkMode}
                  modeChangePending={modeChangePending}
                  onWorkModeChange={changeWorkMode}
                  effort={selectedEffort}
                  skills={skillCommands}
                  plugins={pluginCatalog}
                  pluginMentionsEnabled={pluginMentionsEnabled}
                  commands={applicationCommands}
                  conversations={sessions}
                  activeSessionId={activeSessionId}
                  goalMode={goalMode}
                  goalEditing={goalMode && Boolean(goalComposer.editingGoal)}
                  onGoalModeChange={changeGoalMode}
                  goalAutoTurns={goalComposer.maxAutoTurns}
                  goalTokenBudget={goalComposer.tokenBudget}
                  onGoalTokenBudgetChange={
                    goalComposer.editingGoal
                      ? undefined
                      : (value) => setGoalTokenBudget(composerScope, value)
                  }
                  onGoalAutoTurnsChange={
                    goalComposer.editingGoal
                      ? undefined
                      : (count) => setGoalAutoTurns(composerScope, count)
                  }
                  canSubmit={
                    goalMode ? Boolean(selectGoalObjective(draft)) && canSubmit : canSubmit
                  }
                  contextUsage={contextUsageSnapshot}
                  attachments={attachments}
                  attachmentPreparation={attachmentPreparation}
                  attachmentInteractionEnabled={attachmentSupport.interactionEnabled}
                  onDraftChange={setDraft}
                  onSubmit={() => void submitDraft()}
                  onCommand={executeComposerCommand}
                  onPickFiles={() => pickAttachmentFiles(composerScope)}
                  onDropFiles={(files) => addDroppedAttachments(composerScope, files)}
                  onPasteFiles={(files) => pasteAttachments(files)}
                  onPasteTextAttachment={pasteTextAttachment}
                  onCancelAttachment={(draftId) => cancelAttachment(composerScope, draftId)}
                  onRetryAttachment={(draftId) => retryAttachment(composerScope, draftId)}
                  onRemoveAttachment={(draftId) => {
                    setComposerValidationError(null)
                    return removeAttachment(composerScope, draftId)
                  }}
                  onInterrupt={() => void interrupt()}
                  onOpenContextUsage={() => void refreshContextUsage({ refresh: true })}
                  onSelectModel={(model) => {
                    if (activeSessionId) void updateSessionModel(activeSessionId, model)
                  }}
                  onSelectPermissionMode={(permissionMode) => {
                    if (activeSessionId)
                      void updateSessionPermissionMode(activeSessionId, permissionMode).catch(
                        () => {}
                      )
                    else selectPermissionMode(permissionMode)
                  }}
                  onSelectEffort={(effort) => {
                    if (activeSessionId) void updateSessionEffort(activeSessionId, effort)
                    else selectEffort(effort)
                  }}
                />
              </div>
            )}
          </>
        )}
        {statusOpen ? (
          <div
            role="dialog"
            aria-label="会话状态"
            className="absolute right-5 bottom-5 z-50 w-80 rounded-xl bg-background p-4 shadow-lg ring-1 ring-black/10 dark:ring-white/10"
          >
            <div className="text-sm font-semibold">会话状态</div>
            <div className="mt-2 space-y-1 text-xs text-muted-foreground">
              <div>状态：{sessionView?.session.status ?? "未创建"}</div>
              <div>模型：{currentModel ?? "未选择"}</div>
              <div>运行：{running ? "进行中" : "空闲"}</div>
            </div>
            <button
              type="button"
              className="mt-3 text-xs font-medium text-primary"
              onClick={() => setStatusOpen(false)}
            >
              关闭
            </button>
          </div>
        ) : null}
        {sessionActions.dialogs}
      </section>
    </MessagePluginCatalog.Provider>
  )
}

export { ConversationPane }

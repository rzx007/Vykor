import { Bot, ListFilter, MoreHorizontal, PanelRight, ShieldAlert } from "lucide-react"
import { useCallback, useEffect, useState } from "react"
import { useNavigate } from "@tanstack/react-router"

import { OpenWithSplitButton } from "@renderer/components/desktop/open-with"
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@renderer/components/ui/message-scroller"
import { Spinner } from "@renderer/components/ui/spinner"
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
  selectActiveSessionComposerError,
  selectActiveSessionPermissionReplies,
  selectActiveSessionPromptSubmissions,
  selectActiveSessionQueuedPromptActions,
  selectActiveSessionSending,
  selectCommandCatalogCwd,
  selectNewConversationError,
  selectNewConversationSending,
} from "@renderer/stores/desktop-session/selectors"
import { Composer } from "./composer/composer"
import { pluginMentionsEnabled } from "./composer/plugin-mentions-feature"
import { PluginPreparationStatus } from "./composer/plugin-preparation-status"
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
import {
  toComposerCommands,
  toComposerSkills,
  type ComposerPickerCommand,
} from "./composer/composer-picker"
import type { ComposerSkill } from "./composer/rich-prompt-input"
import { HeaderIconButton } from "./composer/controls"
import { NewConversationStart } from "./session/new-conversation-start"
import { PermissionCard } from "./message/message-block"
import { ProjectInfoButton } from "./session/project-info-popover"
import { SessionMoreMenu } from "./session/session-more-menu"
import { useSessionActionDialogs } from "./session/session-action-dialogs"
import { ScopedOperationError } from "./session/scoped-operation-errors"
import { ConversationTranscriptSkeleton } from "./transcript/conversation-transcript-skeleton"
import { ConversationTranscript } from "./transcript/transcript"
import type { AddToComposerEventDetail, ConversationPaneProps } from "./types"
import {
  resolveScrollerAgentStatus,
  type ScrollerAgentStatusKind,
} from "./transcript/scroller-agent-status"
import { resolveModelLabel } from "./utils"

function ConversationPane({
  panelOpen,
  onTogglePanel,
  onOpenFile,
  canOpenReview,
  onOpenReview,
  onOpenTerminal,
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
  const activeSessionId = useDesktopSessionStore((state) => state.activeSessionId)
  const sessionView = useDesktopSessionStore((state) => state.sessionView)
  const openingSession = useDesktopSessionStore(selectActiveSessionOpening)
  const activeSessionError = useDesktopSessionStore(selectActiveSessionComposerError)
  const newConversationError = useDesktopSessionStore(selectNewConversationError)
  const activeSessionSending = useDesktopSessionStore(selectActiveSessionSending)
  const newConversationSending = useDesktopSessionStore(selectNewConversationSending)
  const models = useDesktopSessionStore((state) => state.models)
  const selectedModel = useDesktopSessionStore((state) => state.selectedModel)
  const selectedProvider = useDesktopSessionStore((state) => state.selectedProvider)
  const selectedPermissionMode = useDesktopSessionStore((state) => state.selectedPermissionMode)
  const workspaceMode = useDesktopSessionStore((state) => state.workspaceMode)
  const selectedProject = useDesktopSessionStore((state) => state.selectedProject)
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
  const refreshGoal = useDesktopSessionStore((state) => state.refreshGoal)
  const applyGoalAction = useDesktopSessionStore((state) => state.applyGoalAction)
  const dismissGoalError = useDesktopSessionStore((state) => state.dismissGoalError)
  const dismissGoalBanner = useDesktopSessionStore((state) => state.dismissGoalBanner)
  const sendMessage = useDesktopSessionStore((state) => state.sendMessage)
  const dismissPromptSubmission = useDesktopSessionStore((state) => state.dismissPromptSubmission)
  const editLatestMessage = useDesktopSessionStore((state) => state.editLatestMessage)
  const promoteQueuedPrompt = useDesktopSessionStore((state) => state.promoteQueuedPrompt)
  const cancelQueuedPrompt = useDesktopSessionStore((state) => state.cancelQueuedPrompt)
  const queuedPromptActions = useDesktopSessionStore(selectActiveSessionQueuedPromptActions)
  const pendingPromptSubmissions = useDesktopSessionStore(selectActiveSessionPromptSubmissions)
  const permissionReplies = useDesktopSessionStore(selectActiveSessionPermissionReplies)
  const forkSession = useDesktopSessionStore((state) => state.forkSession)
  const chooseProject = useDesktopSessionStore((state) => state.chooseProject)
  const selectProject = useDesktopSessionStore((state) => state.selectProject)
  const selectOutsideProject = useDesktopSessionStore((state) => state.selectOutsideProject)
  const checkoutBranch = useDesktopSessionStore((state) => state.checkoutBranch)
  const createAndCheckoutBranch = useDesktopSessionStore((state) => state.createAndCheckoutBranch)
  const selectModel = useDesktopSessionStore((state) => state.selectModel)
  const selectPermissionMode = useDesktopSessionStore((state) => state.selectPermissionMode)
  const updateSessionModel = useDesktopSessionStore((state) => state.updateSessionModel)
  const updateSessionPermissionMode = useDesktopSessionStore(
    (state) => state.updateSessionPermissionMode
  )
  const refreshContextUsage = useDesktopSessionStore((state) => state.refreshContextUsage)
  const resyncActiveSessionSnapshot = useDesktopSessionStore(
    (state) => state.resyncActiveSessionSnapshot
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
  const archived = sessionView?.session.status === "archived"
  const sessionActions = useSessionActionDialogs()

  const submitDraft = async (): Promise<void> => {
    const content = selectComposerDocumentText(draft)
    const ready = areDesktopAttachmentsSendable(attachments)
    if ((!content.trim() && attachments.length === 0) || !ready || sending || archived) return
    setComposerValidationError(null)
    try {
      if (goalMode) {
        await submitGoal(composerScope)
        return
      }
      if (hasSession) {
        await sendMessage(content, { document: draft, attachments })
      } else {
        await startSession(content, { document: draft, attachments })
      }
    } catch (error) {
      if (goalMode)
        setComposerValidationError(error instanceof Error ? error.message : String(error))
      // The store keeps the error and the draft stays available for retry.
    }
  }

  useEffect(() => {
    if (!activeSessionId) return
    void refreshGoal(activeSessionId)
    // Session events handle normal updates; recover a lost event while the view is open.
    const timer = window.setInterval(() => void refreshGoal(activeSessionId), 5_000)
    return () => window.clearInterval(timer)
  }, [activeSessionId, refreshGoal])

  const title = sessionView?.session.title.trim() || "新对话"
  const currentModel = sessionView?.session.model ?? selectedModel
  const modelLabel = resolveModelLabel(models, currentModel, selectedProvider)
  const running = Boolean(
    sessionView?.runs.some((run) => run.status === "pending" || run.status === "running") ||
    sessionView?.session.status === "running"
  )
  const activeRun = sessionView?.runs.find((run) => run.status === "running")
  const pendingPrompts = (sessionView?.runs ?? [])
    .filter((run) => run.status === "pending" && run.inputId)
    .sort((left, right) => left.createdAt - right.createdAt)
    .flatMap((run) => {
      const input = sessionView?.inputs.find((candidate) => candidate.id === run.inputId)
      const action = queuedPromptActions[`${run.sessionId}:${run.id}`]
      return input ? [{ input, run, ...(action ? { action } : {}) }] : []
    })
  const pendingPermissions =
    sessionView?.permissions.filter((permission) => permission.status === "pending") ?? []
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
  const hasAgentTasks = Boolean(
    sessionView?.tasks.some((task) => task.type === "agent" && task.childSessionId)
  )
  const scrollerAgentStatus = resolveScrollerAgentStatus({
    running,
    parts: sessionView?.parts ?? [],
    pendingPermissionCount: pendingPermissions.length,
    agentTaskRunning: sessionView?.tasks.some(
      (task) => task.type === "agent" && (task.status === "pending" || task.status === "running")
    ),
  })
  const commandCwd = useDesktopSessionStore(selectCommandCatalogCwd)
  const commandCatalog =
    commandCwd && skillCommandSnapshot?.cwd === commandCwd ? skillCommandSnapshot.commands : []
  const skillCommands: ComposerSkill[] = toComposerSkills(commandCatalog)
  const applicationCommands = toComposerCommands(commandCatalog)
  const pluginCatalog = pluginMentionsEnabled && pluginSnapshot?.cwd === commandCwd ? pluginSnapshot.plugins : []
  const pluginCatalogError = pluginMentionsEnabled && pluginSnapshot?.cwd === commandCwd ? pluginSnapshot.error ?? null : null
  const canSubmit =
    areDesktopAttachmentsSendable(attachments) &&
    Boolean(draftText.trim() || attachments.length > 0)

  const pasteAttachments = async (files: readonly File[]): Promise<void> => {
    const payloads = await Promise.all(
      files.map(async (file) => ({
        bytes: await file.arrayBuffer(),
        displayName: file.name || "粘贴图片",
        mediaType: file.type || "application/octet-stream",
      }))
    )
    for (const payload of payloads) void addClipboardAttachment(composerScope, payload)
  }

  const copyAssistantMessage = async (content: string): Promise<void> => {
    await window.desktop.clipboard.writeText(content)
  }

  const forkFromAssistantMessage = async (messageId: string): Promise<void> => {
    if (!activeSessionId || archived || running) return
    await forkSession(activeSessionId, { afterMessageId: messageId })
  }

  const editLatestUserMessage = async (
    sourceMessageId: string,
    document: ComposerDocument
  ): Promise<void> => {
    if (archived || running) return
    await editLatestMessage(sourceMessageId, selectComposerDocumentText(document), document)
  }

  useEffect(() => {
    const handleAddToComposer = (event: Event): void => {
      const detail = (event as CustomEvent<AddToComposerEventDetail>).detail
      if (!detail?.text) return
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
  }, [draft.items, setDraft])

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
      (plugins) => { if (!cancelled) setPluginSnapshot({ cwd: commandCwd, plugins }) },
      () => { if (!cancelled) setPluginSnapshot({ cwd: commandCwd, plugins: [], error: "插件列表暂时无法加载，请稍后重试。" }) },
    )
    return () => { cancelled = true }
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
      throw new Error(`Desktop 尚未支持 /${command.id}。`)
    },
    [
      activeSessionId,
      changeGoalMode,
      navigate,
      refreshContextUsage,
      resyncActiveSessionSnapshot,
      running,
    ]
  )

  return (
    <section className="flex h-full min-w-0 flex-1 flex-col overflow-x-hidden bg-conversation">
      {hasSession ? (
        <header className="flex h-12 shrink-0 items-center border-b bg-background px-3">
          <div className="flex min-w-0 items-center gap-2">
            <ProjectInfoButton
              selectedProject={selectedProject}
              projects={projects}
              cwd={sessionView?.session.cwd ?? null}
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
            {hasAgentTasks ? (
              <HeaderIconButton label="查看子智能体" onClick={onOpenAgents}>
                <Bot />
              </HeaderIconButton>
            ) : null}
            <OpenWithSplitButton folderPath={sessionView?.session.cwd ?? selectedProject?.path} />
            <HeaderIconButton label="会话视图">
              <ListFilter />
            </HeaderIconButton>
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
          operationError={composerValidationError ?? newConversationError ?? pluginCatalogError}
          goalError={goalComposer.error}
          onDismissGoalError={() => dismissGoalError(composerScope)}
          goalMode={goalMode}
          onGoalModeChange={changeGoalMode}
          goalAutoTurns={goalComposer.maxAutoTurns}
          onGoalAutoTurnsChange={(count) => setGoalAutoTurns(composerScope, count)}
          commands={applicationCommands.filter((item) => item.command?.id !== "compact")}
          onCommand={executeComposerCommand}
          skills={skillCommands}
          plugins={pluginCatalog}
          pluginMentionsEnabled={pluginMentionsEnabled}
          attachments={attachments}
          attachmentInteractionEnabled={attachmentSupport.interactionEnabled}
          panelOpen={panelOpen}
          onDraftChange={setDraft}
          onSubmit={() => void submitDraft()}
          onPickFiles={() => void pickAttachmentFiles(composerScope)}
          onDropFiles={(files) => void addDroppedAttachments(composerScope, files)}
          onPasteFiles={(files) => void pasteAttachments(files)}
          onCancelAttachment={(draftId) => void cancelAttachment(composerScope, draftId)}
          onRetryAttachment={(draftId) => void retryAttachment(composerScope, draftId)}
          onRemoveAttachment={(draftId) => {
            setComposerValidationError(null)
            void removeAttachment(composerScope, draftId)
          }}
          onChooseProject={() => void chooseProject()}
          onSelectProject={(project) => void selectProject(project)}
          onSelectOutsideProject={selectOutsideProject}
          onCheckoutBranch={checkoutBranch}
          onCreateAndCheckoutBranch={createAndCheckoutBranch}
          onSelectModel={(model) => void selectModel(model)}
          onSelectPermissionMode={(permissionMode) => void selectPermissionMode(permissionMode)}
          onTogglePanel={onTogglePanel}
          contextUsage={contextUsageSnapshot}
          onOpenContextUsage={() => void refreshContextUsage({ refresh: true })}
        />
      ) : (
        <>
          <MessageScrollerProvider
            key={activeSessionId ?? "new-session"}
            autoScroll
            defaultScrollPosition="last-anchor"
            scrollPreviousItemPeek={72}
          >
            <MessageScroller className="min-h-0 min-w-0 flex-1">
              <MessageScrollerViewport className="overflow-x-hidden">
                <MessageScrollerContent className="mx-auto min-h-full w-full max-w-190 min-w-0 gap-6 px-6 pt-7 pb-5 text-content-foreground">
                  {openingSession && !sessionView ? (
                    <ConversationTranscriptSkeleton />
                  ) : (
                    <ConversationTranscript
                      inputs={sessionView?.inputs ?? []}
                      messages={transcript.messages}
                      parts={transcript.parts}
                      runs={sessionView?.runs ?? []}
                      running={running}
                      canEditLastUserMessage={!archived && !running && !sending}
                      onEditLastUserMessage={(sourceMessageId, content) =>
                        void editLatestUserMessage(sourceMessageId, content)
                      }
                      onCopyAssistantMessage={(content) => void copyAssistantMessage(content)}
                      onForkAssistantMessage={(messageId) =>
                        void forkFromAssistantMessage(messageId)
                      }
                      onOpenFile={onOpenFile}
                      canOpenReview={canOpenReview}
                      onOpenReview={onOpenReview}
                      onOpenTerminal={onOpenTerminal}
                    />
                  )}
                </MessageScrollerContent>
              </MessageScrollerViewport>
              <MessageScrollerButton className="bottom-5" title={scrollerAgentStatus?.title}>
                {scrollerAgentStatus ? (
                  <>
                    <ScrollerAgentStatusIcon kind={scrollerAgentStatus.kind} />
                    <span className="sr-only">滚动到最新</span>
                  </>
                ) : undefined}
              </MessageScrollerButton>
            </MessageScroller>
          </MessageScrollerProvider>

          {!archived && pendingPermissions.length > 0 ? (
            <div
              role="region"
              aria-label="待处理的授权请求"
              className="mx-auto mb-2 max-h-[min(18rem,35vh)] w-[min(760px,calc(100%-32px))] shrink-0 scrollbar-thin overflow-y-auto px-px"
            >
              <div className="space-y-2">
                {pendingPermissions.map((permission) => (
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
                ))}
              </div>
            </div>
          ) : null}

          {archived ? (
            <div className="mx-auto mb-5 flex h-12 w-[min(760px,calc(100%-32px))] shrink-0 items-center justify-center rounded-lg border border-border bg-background/90 text-xs text-muted-foreground shadow-sm">
              {"此会话已归档，只能查看历史内容"}
            </div>
          ) : (
            <div className="mx-auto mb-5 flex w-[min(760px,calc(100%-32px))] shrink-0 flex-col gap-2">
              {goal && goalComposer.dismissedGoalId !== goal.id ? (
                <GoalBanner
                  key={`${goal.id}:${goal.wait?.kind === "user" ? goal.wait.questionId : ""}`}
                  goal={goal}
                  busy={goalBusy}
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
              <ScopedOperationError key={`error:${composerScope}`} error={composerValidationError ?? activeSessionError ?? pluginCatalogError} />
              <PluginPreparationStatus activeSessionId={activeSessionId} view={sessionView} />
              <PendingPromptQueue
                prompts={pendingPrompts}
                activeRunId={activeRun?.id}
                localSubmissions={localPromptSubmissions}
                onPromote={(inputId, queuedRunId) => {
                  if (activeRun) void promoteQueuedPrompt(inputId, queuedRunId, activeRun.id)
                }}
                onCancel={(inputId, queuedRunId) => void cancelQueuedPrompt(inputId, queuedRunId)}
                onDismissLocal={dismissPromptSubmission}
              />
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
                skills={skillCommands}
                plugins={pluginCatalog}
                pluginMentionsEnabled={pluginMentionsEnabled}
                commands={applicationCommands.filter(
                  (item) => item.command?.id !== "compact" || !running
                )}
                conversations={sessions}
                activeSessionId={activeSessionId}
                goalMode={goalMode}
                onGoalModeChange={changeGoalMode}
                goalAutoTurns={goalComposer.maxAutoTurns}
                onGoalAutoTurnsChange={
                  goalComposer.editingGoal
                    ? undefined
                    : (count) => setGoalAutoTurns(composerScope, count)
                }
                canSubmit={goalMode ? Boolean(selectGoalObjective(draft)) && canSubmit : canSubmit}
                contextUsage={contextUsageSnapshot}
                attachments={attachments}
                attachmentInteractionEnabled={attachmentSupport.interactionEnabled}
                onDraftChange={setDraft}
                onSubmit={() => void submitDraft()}
                onCommand={executeComposerCommand}
                onPickFiles={() => void pickAttachmentFiles(composerScope)}
                onDropFiles={(files) => void addDroppedAttachments(composerScope, files)}
                onPasteFiles={(files) => void pasteAttachments(files)}
                onCancelAttachment={(draftId) => void cancelAttachment(composerScope, draftId)}
                onRetryAttachment={(draftId) => void retryAttachment(composerScope, draftId)}
                onRemoveAttachment={(draftId) => {
                  setComposerValidationError(null)
                  void removeAttachment(composerScope, draftId)
                }}
                onInterrupt={() => void interrupt()}
                onOpenContextUsage={() => void refreshContextUsage({ refresh: true })}
                onSelectModel={(model) => {
                  if (activeSessionId) void updateSessionModel(activeSessionId, model)
                }}
                onSelectPermissionMode={(permissionMode) => {
                  if (activeSessionId)
                    void updateSessionPermissionMode(activeSessionId, permissionMode)
                  else selectPermissionMode(permissionMode)
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
  )
}

function ScrollerAgentStatusIcon({ kind }: { kind: ScrollerAgentStatusKind }): React.JSX.Element {
  if (kind === "permission") return <ShieldAlert />
  if (kind === "agent") return <Bot />
  return <Spinner />
}

export { ConversationPane }

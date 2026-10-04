import { useEffect, useRef, useState } from "react"
import { MessageSquarePlus, MessageSquareText, X } from "lucide-react"
import { Composer } from "../conversation-page/composer/composer"
import { toComposerSkills } from "../conversation-page/composer/composer-picker-model"
import { toComposerCommands } from "../conversation-page/composer/composer-command-catalog"
import { pluginMentionsEnabled } from "../conversation-page/composer/plugin-mentions-feature"
import { PluginPreparationStatus } from "../conversation-page/composer/plugin-preparation-status"
import { PermissionCard } from "../conversation-page/message/message-block"
import { AskUserCard } from "../conversation-page/message/ask-user-card"
import { isAskUserPermission } from "../conversation-page/message/ask-user-payload"
import { ConversationTranscript } from "../conversation-page/transcript/transcript"
import { mergeOptimisticTranscript } from "../conversation-page/transcript/optimistic-transcript"
import { resolveScrollerAgentStatus } from "../conversation-page/transcript/scroller-agent-status"
import { useShowReasoning } from "../conversation-page/use-show-reasoning"
import { openConversationTextMenu } from "../conversation-page/conversation-text-actions"
import { resolveModelLabel } from "../conversation-page/utils"
import { Alert, AlertDescription } from "@renderer/components/ui/alert"
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from "@renderer/components/ui/empty"
import { Button } from "@renderer/components/ui/button"
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
  PopoverTitle,
} from "@renderer/components/ui/popover"
import {
  MessageScroller,
  MessageScrollerProvider,
  MessageScrollerViewport,
  MessageScrollerContent,
  MessageScrollerButton,
} from "@renderer/components/ui/message-scroller"
import { Spinner } from "@renderer/components/ui/spinner"
import { cn } from "@renderer/lib/utils"
import { useDesktopSessionStore } from "@renderer/stores/desktop-session"
import { composerDocument, selectComposerDocumentText } from "@renderer/stores/desktop-session/composer-document"
import {
  selectDraftDocument,
  selectDraftAttachments,
  sessionComposerScope,
  migrateComposerScope,
} from "@renderer/stores/desktop-session/composer-draft-state"
import {
  sessionProvider,
  sessionPermissionMode,
  sessionEffort,
} from "@renderer/stores/desktop-session/helpers"
import {
  selectSessionRuntime,
  selectSessionSending,
  selectPermissionReplyError,
  selectPermissionReplyPending,
} from "@renderer/stores/desktop-session/selectors"
import { areDesktopAttachmentsSendable } from "@shared/attachment-types"
import type {
  DesktopSessionView,
  DesktopSessionRecord,
  DesktopCommandCatalogEntry,
  DesktopPluginCatalogEntry,
  DesktopModel,
  DesktopPermissionMode,
} from "@shared/session-types"

export const sideChatTargets = new Map<string, string>()
const pendingForks = new Map<string, Promise<DesktopSessionRecord>>()
// Each renderer keeps the association currently displayed in its own panel.
const boundTargets = new Map<string, string | null>()
export function sideChatDraftScope(sourceId: string): string {
  const targetId = boundTargets.get(sourceId)
  const prefork = `linked-chat:${sourceId}`
  return targetId &&
    targetId !== sourceId &&
    !useDesktopSessionStore.getState().composerDraftsByScope[prefork]
    ? sessionComposerScope(targetId)
    : prefork
}
function bindValidatedTarget(sourceId: string, targetId: string): void {
  if (boundTargets.has(sourceId)) boundTargets.set(sourceId, targetId)
  moveSideChatDraft(`linked-chat:${sourceId}`, sessionComposerScope(targetId))
}
function moveSideChatDraft(from: string, to: string, merge = false): void {
  useDesktopSessionStore.setState((state) => {
    const source = state.composerDraftsByScope[from]
    const target = state.composerDraftsByScope[to]
    if (merge && source && target) {
      const migrated = migrateComposerScope(state, from, to)
      return { composerDraftsByScope: {
        ...migrated.composerDraftsByScope,
        [to]: {
          document: composerDocument([
            ...source.document.items,
            ...(source.document.items.length && target.document.items.length
              ? [{ type: "text" as const, text: "\n\n" }] : []),
            ...target.document.items,
          ]),
          attachments: [...source.attachments, ...target.attachments],
          textSelections: [...(source.textSelections ?? []), ...(target.textSelections ?? [])],
        },
      } }
    }
    if (source && target && (target.document.items.length || target.attachments.length))
      return state
    const migrated = migrateComposerScope(state, from, to)
    if (!source || !target?.textSelections?.length) return migrated
    return {
      composerDraftsByScope: {
        ...migrated.composerDraftsByScope,
        [to]: {
          ...source,
          textSelections: [...target.textSelections, ...(source.textSelections ?? [])],
        },
      },
    }
  })
}
function isMissingTarget(cause: unknown, targetId: string): boolean {
  const message = cause instanceof Error ? cause.message : String(cause)
  return message.replace(/^Error invoking remote method 'session:aux-open': (?:Error|VykorApiError): /, "") ===
    `Session not found: ${targetId}`
}
export function appendSideChatQuote(sourceId: string, text: string): void {
  if (!text.trim()) return
  const state = useDesktopSessionStore.getState()
  const scope = sideChatDraftScope(sourceId)
  const current = state.composerDraftsByScope[scope] ?? {
    document: selectDraftDocument(state, scope),
    attachments: [],
  }
  useDesktopSessionStore.setState({
    composerDraftsByScope: {
      ...state.composerDraftsByScope,
      [scope]: {
        ...current,
        textSelections: [...(current.textSelections ?? []), { id: crypto.randomUUID(), text }],
      },
    },
  })
}
function forkTarget(sourceId: string): Promise<DesktopSessionRecord> {
  const pending = pendingForks.get(sourceId)
  if (pending) return pending
  const request = window.desktop.sessions
    .fork({ sessionId: sourceId, storage: "memory" })
    .then((session) => {
      if (session.id === sourceId || session.parentId !== sourceId || session.storage !== "memory")
        throw new Error("侧边聊天的来源不匹配，未发送消息。")
      sideChatTargets.set(sourceId, session.id)
      bindValidatedTarget(sourceId, session.id)
      return session
    })
    .finally(() => pendingForks.delete(sourceId))
  pendingForks.set(sourceId, request)
  return request
}

export function SideChatPanel({
  sourceId,
  active,
  focusRequest,
  onOpenFile,
  canOpenReview,
  onOpenReview,
  onOpenTerminal,
}: {
  sourceId: string
  active: boolean
  focusRequest?: number
  onOpenFile: (path: string, line?: number) => void
  canOpenReview: boolean
  onOpenReview: (path?: string) => void
  onOpenTerminal: (terminalId: string) => void
}): React.JSX.Element {
  const [targetId, setTargetId] = useState(() => sideChatTargets.get(sourceId) ?? null)
  const [view, setView] = useState<DesktopSessionView | null>(null)
  const verifiedTargetId =
    targetId &&
    targetId !== sourceId &&
    view?.session.id === targetId &&
    view.session.parentId === sourceId &&
    view.session.storage === "memory"
      ? targetId
      : null
  const [error, setError] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [creating, setCreating] = useState(() => pendingForks.has(sourceId))
  const [catalog, setCatalog] = useState<{
    cwd: string
    commands: DesktopCommandCatalogEntry[]
    plugins: DesktopPluginCatalogEntry[]
    error?: string
  } | null>(null)
  const [preferences, setPreferences] = useState<{
    model?: DesktopModel
    mode?: DesktopPermissionMode
    effort?: string
  }>({})
  const [subscriptionId] = useState(() => `side-chat:${crypto.randomUUID()}`)
  const acceptedView = useRef<DesktopSessionView | null>(null)
  const submitPending = useRef(false)
  const mounted = useRef(true)
  const sectionRef = useRef<HTMLElement>(null)
  const source = useDesktopSessionStore((state) =>
    state.sessionView?.session.id === sourceId
      ? state.sessionView.session
      : state.sessions.find((session) => session.id === sourceId)
  )
  const models = useDesktopSessionStore((state) => state.models)
  const sessions = useDesktopSessionStore((state) => state.sessions)
  const defaults = useDesktopSessionStore((state) => state.defaultPermissionMode)
  const providerDefault = useDesktopSessionStore((state) => state.defaultProvider)
  const support = useDesktopSessionStore((state) => state.attachmentSupport)
  const runtime = useDesktopSessionStore((state) => selectSessionRuntime(state, verifiedTargetId))
  const sending = useDesktopSessionStore((state) =>
    verifiedTargetId ? selectSessionSending(state, verifiedTargetId) : false
  )
  const preforkScope = `linked-chat:${sourceId}`
  const preforkDraft = useDesktopSessionStore((state) => state.composerDraftsByScope[preforkScope])
  const targetDraft = useDesktopSessionStore((state) =>
    verifiedTargetId
      ? state.composerDraftsByScope[sessionComposerScope(verifiedTargetId)]
      : undefined
  )
  const draftConflict = Boolean(
    preforkDraft &&
    targetDraft &&
    (targetDraft.document.items.length ||
      targetDraft.attachments.length ||
      targetDraft.textSelections?.length)
  )
  const scope =
    verifiedTargetId && !preforkDraft ? sessionComposerScope(verifiedTargetId) : preforkScope
  const draft = useDesktopSessionStore((state) => selectDraftDocument(state, scope))
  const attachments = useDesktopSessionStore((state) => selectDraftAttachments(state, scope))
  const textSelections = (scope === preforkScope ? preforkDraft : targetDraft)?.textSelections ?? []
  const storedTarget = verifiedTargetId
    ? sessions.find((item) => item.id === verifiedTargetId)
    : undefined
  // Equal timestamps keep immediate RPC feedback; a newer accepted view wins.
  const session =
    storedTarget && (!view || storedTarget.updatedAt >= view.session.updatedAt)
      ? storedTarget
      : (view?.session ?? source)
  const cwd = session?.cwd
  const showReasoning = useShowReasoning()
  const model = (!targetId ? preferences.model?.id : undefined) ?? session?.model ?? null
  const provider =
    (!targetId ? preferences.model?.providerName : undefined) ??
    (session ? sessionProvider(session, providerDefault) : providerDefault)
  const mode =
    (!targetId ? preferences.mode : undefined) ??
    (session ? sessionPermissionMode(session, defaults) : defaults)
  const effort =
    (!targetId ? preferences.effort : undefined) ?? (session ? sessionEffort(session) : null)
  const running = Boolean(
    view?.runs.some((run) => run.status === "running" || run.status === "pending")
  )
  const archived = view?.session.status === "archived"
  const permissions =
    view?.permissions.filter((permission) => permission.status === "pending") ?? []
  const submissions = Object.values(runtime.pendingPromptSubmissions)
  const runtimeError = Object.values(runtime.operations)
    .filter((operation) => operation.phase === "failed" && operation.kind !== "reply-permission")
    .at(-1)?.error
  const unavailable = Boolean(targetId && (!verifiedTargetId || loadError || draftConflict))
  const transcript = mergeOptimisticTranscript(view?.messages ?? [], view?.parts ?? [], submissions)
  const status = resolveScrollerAgentStatus({
    running,
    parts: view?.parts ?? [],
    pendingPermissionCount: permissions.length,
    agentTaskRunning: view?.tasks.some(
      (task) => task.type === "agent" && (task.status === "running" || task.status === "pending")
    ),
  })

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  useEffect(() => {
    boundTargets.set(sourceId, null)
    return () => {
      boundTargets.delete(sourceId)
    }
  }, [sourceId])
  useEffect(() => {
    const pending = pendingForks.get(sourceId)
    if (!pending) return
    let disposed = false
    void pending.then(
      (target) => {
        if (!disposed) {
          setTargetId(target.id)
          setCreating(false)
        }
      },
      (cause) => {
        if (!disposed) {
          setError(cause instanceof Error ? cause.message : String(cause))
          setCreating(false)
        }
      }
    )
    return () => {
      disposed = true
    }
  }, [sourceId])
  useEffect(() => {
    if (!targetId || !active) return
    let disposed = false
    let checking = false
    // A separate snapshot check leaves the existing live subscription intact on network errors.
    const checkSubscriptionId = `${subscriptionId}:check:${crypto.randomUUID()}`
    const recoverMissingTarget = (cause: unknown): boolean => {
      if (disposed || !isMissingTarget(cause, targetId)) return false
      if (sideChatTargets.get(sourceId) === targetId) sideChatTargets.delete(sourceId)
      moveSideChatDraft(sessionComposerScope(targetId), `linked-chat:${sourceId}`, true)
      boundTargets.set(sourceId, null)
      acceptedView.current = null
      setView(null)
      setTargetId(null)
      setLoadError(null)
      setError(null)
      return true
    }
    const checkTarget = (): void => {
      if (disposed || checking) return
      checking = true
      void window.desktop.sessions.openAux({ subscriptionId: checkSubscriptionId, sessionId: targetId })
        .then(() => {}, (cause) => { recoverMissingTarget(cause) })
        .finally(async () => {
          await window.desktop.sessions.closeAux({ subscriptionId: checkSubscriptionId }).catch(() => {})
          checking = false
        })
    }
    const accept = (next: DesktopSessionView, snapshot = false): void => {
      if (disposed) return
      if (
        next.session.id === sourceId ||
        next.session.id !== targetId ||
        next.session.parentId !== sourceId ||
        next.session.storage !== "memory"
      ) {
        if (snapshot) {
          boundTargets.set(sourceId, null)
          acceptedView.current = null
          setView(null)
          setLoadError("侧边聊天的来源不匹配，未发送消息。")
        }
        return
      }
      if (acceptedView.current && next.cursor < acceptedView.current.cursor) return
      bindValidatedTarget(sourceId, targetId)
      acceptedView.current = next
      useDesktopSessionStore.getState().applySessionUpdate(next)
      setView(next)
      setLoadError(null)
      if (next.syncStatus === "reconnecting") checkTarget()
    }
    const unsubscribe = window.desktop.sessions.onAuxUpdated((update) => {
      if (update.subscriptionId === subscriptionId) accept(update.view)
    })
    void window.desktop.sessions.openAux({ subscriptionId, sessionId: targetId }).then(
      (next) => accept(next, true),
      (cause) => {
        if (!disposed) {
          if (recoverMissingTarget(cause)) return
          boundTargets.set(sourceId, null)
          acceptedView.current = null
          setView(null)
          setLoadError(cause instanceof Error ? cause.message : String(cause))
        }
      }
    )
    return () => {
      disposed = true
      unsubscribe()
      void window.desktop.sessions.closeAux({ subscriptionId }).catch(() => {})
      if (checking)
        void window.desktop.sessions.closeAux({ subscriptionId: checkSubscriptionId }).catch(() => {})
    }
  }, [active, sourceId, subscriptionId, targetId])

  useEffect(() => {
    if (!cwd) return
    let disposed = false
    void Promise.all([
      window.desktop.sessions.listCommands(cwd),
      pluginMentionsEnabled ? window.desktop.sessions.listContextPlugins(cwd) : Promise.resolve([]),
    ]).then(
      ([commands, plugins]) => {
        if (!disposed) setCatalog({ cwd, commands, plugins })
      },
      () => {
        if (!disposed)
          setCatalog({
            cwd,
            commands: [],
            plugins: [],
            error: "命令或插件列表暂时无法加载，请稍后重试。",
          })
      }
    )
    return () => {
      disposed = true
    }
  }, [cwd])
  useEffect(() => {
    if (!active) return
    const frame = requestAnimationFrame(() =>
      sectionRef.current?.querySelector<HTMLElement>('[contenteditable="true"]')?.focus()
    )
    return () => cancelAnimationFrame(frame)
  }, [active, focusRequest])

  const submit = async (): Promise<void> => {
    if (creating || submitPending.current || sending || archived || unavailable) return
    if (
      (!selectComposerDocumentText(draft).trim() && !attachments.length) ||
      !areDesktopAttachmentsSendable(attachments)
    )
      return
    submitPending.current = true
    setError(null)
    const submittedSelections = textSelections
    try {
      let id = targetId
      if (!id) {
        setCreating(true)
        const target = await forkTarget(sourceId)
        id = target.id
        if (mounted.current) {
          setTargetId(id)
          setPreferences({})
        }
        const remaining = useDesktopSessionStore.getState().composerDraftsByScope
        if (remaining[preforkScope])
          throw new Error("两份草稿均已保留。请先在普通分支聊天中处理已有草稿，再发送这份草稿。")
        const actions = useDesktopSessionStore.getState()
        if (preferences.model) await actions.updateSessionModel(id, preferences.model)
        if (preferences.mode) await actions.updateSessionPermissionMode(id, preferences.mode)
        if (preferences.effort !== undefined)
          await actions.updateSessionEffort(id, preferences.effort)
      }
      const state = useDesktopSessionStore.getState()
      if (state.composerDraftsByScope[preforkScope])
        state.migrateComposerDraft(preforkScope, sessionComposerScope(id))
      await state.sendMessage(selectComposerDocumentText(draft), {
        document: draft,
        attachments,
        target: { sessionId: id, view: acceptedView.current },
        contextItems: [
          { type: "context", kind: "conversation", id: sourceId, displayName: "主聊天" },
          ...submittedSelections.map((selection) => ({
            type: "text" as const,
            text: `选中文本片段：\n${selection.text
              .split("\n")
              .map((line) => `> ${line}`)
              .join("\n")}\n\n`,
          })),
        ],
      })
      const submittedIds = new Set(submittedSelections.map((selection) => selection.id))
      useDesktopSessionStore.setState((current) => {
        const targetScope = sessionComposerScope(id)
        const currentDraft = current.composerDraftsByScope[targetScope]
        if (!currentDraft?.textSelections?.some((selection) => submittedIds.has(selection.id)))
          return current
        return {
          composerDraftsByScope: {
            ...current.composerDraftsByScope,
            [targetScope]: {
              ...currentDraft,
              textSelections: currentDraft.textSelections.filter(
                (selection) => !submittedIds.has(selection.id)
              ),
            },
          },
        }
      })
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      submitPending.current = false
      if (mounted.current) setCreating(false)
    }
  }
  const update = (operation: Promise<void>): void => {
    void operation.catch((cause) =>
      setError(cause instanceof Error ? cause.message : String(cause))
    )
  }
  const actions = useDesktopSessionStore.getState()
  const commands = toComposerCommands(catalog && catalog.cwd === cwd ? catalog.commands : [], {
    hasSession: !!verifiedTargetId,
    running,
    canOpenReview,
    pinned: false,
    permissionMode: mode,
    hasModels: !!models.length,
    hasEffortTiers: !!models.find((item) => item.id === model)?.reasoningEfforts?.length,
  }).filter(
    (command) => command.id === "compact" || command.id === "model" || command.id === "effort"
  )
  return (
    <section
      ref={sectionRef}
      aria-label="侧边聊天"
      className={cn("size-full min-h-0 flex-col bg-conversation", active ? "flex" : "hidden")}
    >
      <MessageScrollerProvider autoScroll defaultScrollPosition="end">
        <MessageScroller className="min-h-0 flex-1">
          <MessageScrollerViewport onContextMenu={(event) => void openConversationTextMenu(event)}>
            <MessageScrollerContent className="mx-auto min-h-full w-full max-w-190 min-w-0 gap-6 px-6 pt-7 pb-5 text-content-foreground">
              {view || submissions.length ? (
                <ConversationTranscript
                  inputs={view?.inputs ?? []}
                  tasks={view?.tasks}
                  messages={transcript.messages}
                  parts={transcript.parts}
                  runs={view?.runs ?? []}
                  running={running}
                  canEditLastUserMessage={false}
                  onEditLastUserMessage={() => {}}
                  onCopyAssistantMessage={(content) =>
                    void window.desktop.clipboard.writeText(content)
                  }
                  showReasoning={showReasoning}
                  onOpenFile={onOpenFile}
                  canOpenReview={canOpenReview}
                  onOpenReview={onOpenReview}
                  onOpenTerminal={onOpenTerminal}
                />
              ) : (
                <Empty>
                  <EmptyHeader>
                    <EmptyMedia>
                      <MessageSquarePlus className="size-7 text-muted-foreground" />
                    </EmptyMedia>
                    <EmptyTitle>侧边聊天</EmptyTitle>
                    <EmptyDescription>围绕主聊天继续提问，不打断左侧任务。</EmptyDescription>
                  </EmptyHeader>
                </Empty>
              )}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton title={status?.title} />
        </MessageScroller>
      </MessageScrollerProvider>
      <div className="mx-auto mb-4 flex w-[min(760px,calc(100%-32px))] shrink-0 flex-col gap-2 px-px">
        {view?.syncStatus === "reconnecting" ? (
          <p role="status" className="text-xs text-muted-foreground">
            正在重新连接聊天
          </p>
        ) : null}
        {draftConflict || error || loadError || runtimeError || catalog?.error ? (
          <Alert variant="destructive">
            <AlertDescription>
              {draftConflict
                ? "两份草稿均已保留。请先在普通分支聊天中处理已有草稿，再发送这份草稿。"
                : (error ?? loadError ?? runtimeError ?? catalog?.error)}
            </AlertDescription>
          </Alert>
        ) : null}
        {creating || (targetId && !view && !loadError) ? (
          <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
            <Spinner />
            正在准备侧边聊天
          </p>
        ) : null}
        {!archived
          ? permissions.map((permission) => {
              const state = useDesktopSessionStore.getState()
              const pending = selectPermissionReplyPending(state, targetId!, permission.id)
              const replyError = selectPermissionReplyError(state, targetId!, permission.id)
              return isAskUserPermission(permission) ? (
                <AskUserCard
                  key={`${permission.id}:${replyError ?? "active"}`}
                  permission={permission}
                  replyPending={pending}
                  replyError={replyError}
                  onReply={(answer) =>
                    void state.replyPermission(permission.id, "approved", "once", answer, targetId!)
                  }
                />
              ) : (
                <PermissionCard
                  key={permission.id}
                  permission={permission}
                  replyPending={pending}
                  replyError={replyError}
                  onReply={(status, decision) =>
                    void state.replyPermission(
                      permission.id,
                      status,
                      decision,
                      undefined,
                      targetId!
                    )
                  }
                />
              )
            })
          : null}
        {archived ? (
          <Alert>
            <AlertDescription>此会话已归档，只能查看历史内容</AlertDescription>
          </Alert>
        ) : (
          <>
            <PluginPreparationStatus activeSessionId={targetId} view={view} />
            <Composer
              id={`side-chat-composer-${sourceId}`}
              contextContent={
                textSelections.length ? (
                  <div className="px-3 pt-3">
                    <Popover>
                      <PopoverTrigger
                        render={<Button type="button" variant="outline" size="xs" />}
                        aria-label="查看已选文本片段"
                      >
                        <MessageSquareText data-icon="inline-start" />
                        {textSelections.length} 个已选文本片段
                      </PopoverTrigger>
                      <PopoverContent
                        side="top"
                        align="start"
                        className="w-80 max-w-[calc(100vw-32px)]"
                      >
                        <PopoverTitle>已选文本片段</PopoverTitle>
                        <ul className="flex max-h-64 flex-col gap-3 overflow-y-auto">
                          {textSelections.map((selection, index) => (
                            <li key={selection.id} className="flex min-w-0 items-start gap-2">
                              <p className="min-w-0 flex-1 break-words whitespace-pre-wrap">
                                {selection.text}
                              </p>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon-sm"
                                aria-label={`移除文本片段 ${index + 1}`}
                                disabled={sending || creating}
                                onClick={() => {
                                  useDesktopSessionStore.setState((current) => {
                                    const currentDraft = current.composerDraftsByScope[scope]
                                    if (!currentDraft) return current
                                    return {
                                      composerDraftsByScope: {
                                        ...current.composerDraftsByScope,
                                        [scope]: {
                                          ...currentDraft,
                                          textSelections: currentDraft.textSelections?.filter(
                                            (item) => item.id !== selection.id
                                          ),
                                        },
                                      },
                                    }
                                  })
                                  sectionRef.current
                                    ?.querySelector<HTMLElement>('[contenteditable="true"]')
                                    ?.focus()
                                }}
                              >
                                <X />
                              </Button>
                            </li>
                          ))}
                        </ul>
                      </PopoverContent>
                    </Popover>
                  </div>
                ) : null
              }
              draft={draft}
              sending={sending || creating}
              running={running}
              models={models}
              selectedModel={model}
              selectedProvider={provider}
              modelLabel={resolveModelLabel(models, model, provider)}
              permissionMode={mode}
              effort={effort}
              skills={toComposerSkills(catalog && catalog.cwd === cwd ? catalog.commands : [])}
              plugins={catalog && catalog.cwd === cwd ? catalog.plugins : []}
              commands={commands}
              conversations={sessions}
              activeSessionId={targetId}
              canSubmit={
                !unavailable &&
                areDesktopAttachmentsSendable(attachments) &&
                !!(selectComposerDocumentText(draft).trim() || attachments.length)
              }
              onDraftChange={(next) => {
                setError(null)
                actions.setComposerDraftDocument(scope, next)
              }}
              onSubmit={() => void submit()}
              onInterrupt={() =>
                targetId && update(actions.interrupt({ sessionId: targetId, view }))
              }
              onSelectModel={(next) => {
                if (creating || unavailable) return
                if (targetId) update(actions.updateSessionModel(targetId, next))
                else setPreferences((current) => ({ ...current, model: next }))
              }}
              onSelectPermissionMode={(next) => {
                if (creating || unavailable) return
                if (targetId) update(actions.updateSessionPermissionMode(targetId, next))
                else setPreferences((current) => ({ ...current, mode: next }))
              }}
              onSelectEffort={(next) => {
                if (creating || unavailable) return
                if (targetId) update(actions.updateSessionEffort(targetId, next))
                else setPreferences((current) => ({ ...current, effort: next }))
              }}
              onCommand={async (command) => {
                if (command.id === "compact") {
                  if (!verifiedTargetId || running) throw new Error("当前会话无法压缩。")
                  await window.desktop.sessions.compact({ sessionId: verifiedTargetId })
                }
              }}
              attachments={attachments}
              attachmentInteractionEnabled={support.interactionEnabled}
              attachmentReadOnly={unavailable}
              onPickFiles={() => update(actions.pickAttachmentFiles(scope))}
              onDropFiles={(files) => update(actions.addDroppedAttachments(scope, files))}
              onPasteFiles={(files) => {
                for (const file of files)
                  update(
                    file.arrayBuffer().then((bytes) =>
                      actions.addClipboardAttachment(scope, {
                        bytes,
                        displayName: file.name || "粘贴图片",
                        mediaType: file.type || "application/octet-stream",
                      })
                    )
                  )
              }}
              onCancelAttachment={(id) => update(actions.cancelAttachment(scope, id))}
              onRetryAttachment={(id) => update(actions.retryAttachment(scope, id))}
              onRemoveAttachment={(id) => update(actions.removeAttachment(scope, id))}
            />
          </>
        )}
      </div>
    </section>
  )
}

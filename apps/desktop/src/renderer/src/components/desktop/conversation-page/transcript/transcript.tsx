import { Fragment, useMemo, useRef, useState } from "react"
import {
  readSessionModelRetryState,
  readSessionModelUsage,
  readWorkspaceChangesMetadata,
} from "@vykor/client"
import type { ComposerDocument } from "@renderer/stores/desktop-session/composer-document"
import type { DesktopSessionInput } from "@shared/session-types"

import { messageTextContent } from "../message/message-content"
import { AssistantMessage } from "../message/assistant-message"
import { buildConversationEntries } from "../message/conversation-turn-model"
import { ContextCompactionDivider } from "../message/context-compaction-divider"
import { ModelRetryNotice } from "../message/model-retry-notice"
import { ModelUsageNotice } from "../message/model-usage-notice"
import { visibleTranscriptParts } from "./transcript-visibility"
import { planTurnBlocks } from "./turn-block-plan"
import { selectRunNotices } from "./run-notices"
import { TaskDuration } from "../message/task-duration"
import { taskTiming } from "../message/task-timing"
import { conversationActivityLabel } from "../message/message-render-model"
import {
  isToolGenerationPresentation,
  withToolGenerationPresentation,
} from "../message/tool-generation-presentation"
import { MessageScrollerItem } from "@renderer/components/ui/message-scroller"
import type {
  DesktopSessionMessage,
  DesktopSessionPart,
  DesktopSessionRun,
} from "@shared/session-types"
import type { ConversationEntry } from "../message/conversation-turn-model"
import { AssistantMessageActions, MessageBlock } from "../message/message-block"
import { RunErrorNotice } from "../message/run-error-notice"
import { ContentEntrance } from "../message/content-entrance"

export function ConversationTranscript({
  messages,
  inputs = [],
  parts,
  runs,
  running,
  canEditLastUserMessage,
  onEditLastUserMessage,
  onCopyAssistantMessage,
  onForkAssistantMessage,
  onOpenFile,
  canOpenReview,
  onOpenReview,
  onOpenTerminal,
  showReasoning = true,
  tasks,
  onOpenAgents,
}: {
  messages: DesktopSessionMessage[]
  inputs?: DesktopSessionInput[]
  parts: DesktopSessionPart[]
  runs: DesktopSessionRun[]
  running: boolean
  canEditLastUserMessage: boolean
  onEditLastUserMessage: (sourceMessageId: string, document: ComposerDocument) => void
  onCopyAssistantMessage: (content: string) => void
  onForkAssistantMessage?: (messageId: string) => void
  onOpenFile: (path: string, line?: number) => void
  canOpenReview: boolean
  onOpenReview: (path?: string) => void
  onOpenTerminal: (terminalId: string) => void
  showReasoning?: boolean
  tasks?: import("@shared/session-types").DesktopSessionTask[]
  onOpenAgents?: (taskId?: string) => void
}): React.JSX.Element {
  const modelCache = useRef<TranscriptModelCache | null>(null)
  const {
    entries,
    streamingPart,
    activityLabel,
    activeRun,
    activeRunGrouped,
  } = useTranscriptModel(modelCache, { messages, parts, runs, running, showReasoning })
  const lastTurn = useMemo(
    () => [...entries].reverse().find((entry) => entry.type === "turn"),
    [entries]
  )
  const lastUserMessage = useMemo(
    () =>
      [...entries]
        .reverse()
        .flatMap((entry) =>
          entry.type === "turn" && entry.turn.userMessage ? [entry.turn.userMessage] : []
        )[0],
    [entries]
  )
  const noticeRuns = useMemo(() => selectRunNotices(runs), [runs])
  const modelRetry = useMemo(() => {
    for (const run of runs) {
      if (run.status !== "running" && run.status !== "pending") continue
      const state = readSessionModelRetryState(run.metadata)
      if (state) return state
    }
    return undefined
  }, [runs])
  const runningLabel = modelRetry ? "等待重试" : (activityLabel ?? "进行中")
  const turnPlansById = useMemo(() => {
    const plans = new Map<string, ReturnType<typeof planTurnBlocks>>()
    for (const entry of entries) {
      if (entry.type === "turn") {
        plans.set(
          entry.turn.id,
          planTurnBlocks(entry.turn, {
            streaming: running && entry === lastTurn,
          })
        )
      }
    }
    return plans
  }, [entries, lastTurn, running])

  // 外层滚动容器随聊天或加载状态重新挂载，这份初始记录只属于当前聊天。
  const [initialPartIds] = useState(() => new Set(parts.map((part) => part.id)))

  if (messages.length === 0 && !running && noticeRuns.length === 0) {
    return (
      <MessageScrollerItem>
        <div className="flex min-h-80 items-center justify-center text-sm text-ui-muted">
          这个会话还没有消息
        </div>
      </MessageScrollerItem>
    )
  }

  return (
    <>
      {entries.map((entry) => {
        if (entry.type === "system") {
          return (
            <MessageScrollerItem key={entry.system.id} messageId={entry.system.id}>
              {entry.system.compactionPhase ? (
                <ContextCompactionDivider
                  presentation={{
                    kind: "context_compaction",
                    phase: entry.system.compactionPhase,
                  }}
                />
              ) : (
                <MessageBlock
                  message={entry.system.message}
                  parts={entry.system.parts}
                  streaming={false}
                  onOpenFile={onOpenFile}
                  canOpenReview={canOpenReview}
                  onOpenReview={onOpenReview}
                  onOpenTerminal={onOpenTerminal}
                />
              )}
            </MessageScrollerItem>
          )
        }
        const turnFailures = noticeRuns.filter(
          (run) =>
            entry.turn.runIds.includes(run.id) ||
            (Boolean(run.inputId) && run.inputId === entry.turn.inputId)
        )
        const userMessage = entry.turn.userMessage
        const timing = taskTiming(runs.filter((run) => entry.turn.runIds.includes(run.id)))
        const turnUsageRuns = runs.filter(
          (run) =>
            import.meta.env.DEV &&
            entry.turn.runIds.includes(run.id) &&
            readSessionModelUsage(run.metadata)?.incomplete
        )
        const cachedPlan = turnPlansById.get(entry.turn.id) ?? []
        const turnPlan =
          streamingPart && entry === lastTurn
            ? replacePlannedPart(cachedPlan, streamingPart)
            : cachedPlan
        const lastAssistantKey = [...turnPlan]
          .reverse()
          .find((item) => item.kind === "assistant")?.key
        return (
          <Fragment key={entry.turn.id}>
            {userMessage ? (
              <MessageScrollerItem
                messageId={userMessage.inputId ?? userMessage.id}
                scrollAnchor={userMessage.id === lastUserMessage?.id}
                className="pt-2"
              >
                <ContentEntrance animate={userMessage.metadata.optimistic === true}>
                  <MessageBlock
                    message={userMessage}
                    inputItems={inputs.find((input) => input.id === userMessage.inputId)?.items}
                    parts={entry.turn.userParts}
                    streaming={false}
                    userActions={{
                      canEdit: canEditLastUserMessage && userMessage.id === lastUserMessage?.id,
                      onEdit: (content) => onEditLastUserMessage(userMessage.id, content),
                    }}
                    onOpenFile={onOpenFile}
                    canOpenReview={canOpenReview}
                    onOpenReview={onOpenReview}
                    onOpenTerminal={onOpenTerminal}
                  />
                </ContentEntrance>
              </MessageScrollerItem>
            ) : null}
            {turnPlan.map((item) =>
              item.kind === "divider" && item.phase ? (
                <MessageScrollerItem key={item.key} messageId={item.messageId}>
                  <ContextCompactionDivider
                    presentation={{ kind: "context_compaction", phase: item.phase }}
                  />
                </MessageScrollerItem>
              ) : (
                <MessageScrollerItem
                  key={item.key}
                  messageId={item.messageId}
                  className="group/msg min-w-0"
                >
                  <AssistantMessage
                    parts={item.parts}
                    observations={runs
                      .filter((run) => entry.turn.runIds.includes(run.id))
                      .flatMap((run) => {
                        const result = readWorkspaceChangesMetadata(run.metadata.workspaceChanges)
                        return result ? [result] : []
                      })}
                    showObservations={item.key === lastAssistantKey}
                    streaming={item.streaming}
                    initialPartIds={initialPartIds}
                    tasks={tasks}
                    onOpenAgents={onOpenAgents}
                    onOpenFile={onOpenFile}
                    canOpenReview={canOpenReview}
                    onOpenReview={onOpenReview}
                    onOpenTerminal={onOpenTerminal}
                  />
                  {item.key === lastAssistantKey ? (
                    <TaskDuration timing={timing} label={runningLabel} />
                  ) : null}
                  {item.showActions && !item.parts.some(isToolGenerationPresentation) ? (
                    <AssistantMessageActions
                      message={entry.turn.assistantMessages.at(-1)}
                      content={messageTextContent(entry.turn.assistantParts)}
                      disabled={false}
                      onCopy={onCopyAssistantMessage}
                      onFork={onForkAssistantMessage}
                    />
                  ) : null}
                  {item.key === lastAssistantKey &&
                  (turnUsageRuns.length > 0 || turnFailures.length > 0) ? (
                    <div className="mt-3 flex flex-col gap-3">
                      {turnUsageRuns.map((run) => (
                        <ModelUsageNotice key={run.id} metadata={run.metadata} />
                      ))}
                      {turnFailures.map((run) => (
                        <RunErrorNotice key={run.id} error={run.error} />
                      ))}
                    </div>
                  ) : null}
                </MessageScrollerItem>
              )
            )}
            {lastAssistantKey === undefined ? (
              <>
                {timing ? (
                  <MessageScrollerItem messageId={`${entry.turn.id}-duration`}>
                    <TaskDuration timing={timing} label={runningLabel} />
                  </MessageScrollerItem>
                ) : null}
                {turnUsageRuns.map((run) => (
                  <MessageScrollerItem key={`usage-${run.id}`} messageId={`usage-${run.id}`}>
                    <ModelUsageNotice metadata={run.metadata} />
                  </MessageScrollerItem>
                ))}
                {turnFailures.map((run) => (
                  <MessageScrollerItem key={run.id} messageId={`run-error-${run.id}`}>
                    <RunErrorNotice error={run.error} />
                  </MessageScrollerItem>
                ))}
              </>
            ) : null}
          </Fragment>
        )
      })}
      {modelRetry ? (
        <MessageScrollerItem messageId="conversation-model-retry">
          <ModelRetryNotice retry={modelRetry} />
        </MessageScrollerItem>
      ) : null}
      {running && !activeRunGrouped ? (
        <MessageScrollerItem messageId="conversation-running-status">
          <TaskDuration
            timing={activeRun ? taskTiming([activeRun]) : { status: "pending" }}
            label={runningLabel}
          />
        </MessageScrollerItem>
      ) : null}
    </>
  )
}

interface TranscriptModelCache {
  messages: DesktopSessionMessage[]
  parts: DesktopSessionPart[]
  runs: DesktopSessionRun[]
  running: boolean
  showReasoning: boolean
  visibleParts: DesktopSessionPart[]
  entries: ConversationEntry[]
  visiblePartIds: Set<string>
  lastAssistantMessageId?: string
  activityLabel?: string
  activeRun?: DesktopSessionRun
  activeRunGrouped: boolean
}

type TranscriptModelInput = Pick<
  TranscriptModelCache,
  "messages" | "parts" | "runs" | "running" | "showReasoning"
>

function useTranscriptModel(
  cacheRef: React.MutableRefObject<TranscriptModelCache | null>,
  input: TranscriptModelInput
): {
  entries: ConversationEntry[]
  streamingPart?: DesktopSessionPart
  activityLabel?: string
  activeRun?: DesktopSessionRun
  activeRunGrouped: boolean
} {
  const previous = cacheRef.current
  if (
    previous &&
    previous.running === input.running &&
    previous.showReasoning === input.showReasoning &&
    sameReferences(previous.messages, input.messages) &&
    sameReferences(previous.runs, input.runs)
  ) {
    const updatedPart = findSingleTextAppend(previous.parts, input.parts)
    const canReuse =
      updatedPart === null ||
      (updatedPart !== undefined &&
        previous.lastAssistantMessageId === updatedPart.messageId &&
        (previous.visiblePartIds.has(updatedPart.id) ||
          (updatedPart.type === "reasoning" && !input.showReasoning)))
    if (canReuse) {
      cacheRef.current = {
        ...input,
        visibleParts: previous.visibleParts,
        entries: previous.entries,
        visiblePartIds: previous.visiblePartIds,
        lastAssistantMessageId: previous.lastAssistantMessageId,
        activityLabel: previous.activityLabel,
        activeRun: previous.activeRun,
        activeRunGrouped: previous.activeRunGrouped,
      }
      return {
        entries: previous.entries,
        activityLabel: previous.activityLabel,
        activeRun: previous.activeRun,
        activeRunGrouped: previous.activeRunGrouped,
        streamingPart:
          updatedPart && previous.visiblePartIds.has(updatedPart.id)
            ? updatedPart
            : undefined,
      }
    }
  }

  const visibleParts = visibleTranscriptParts(input.parts, input.showReasoning)
  const presentation = input.running
    ? withToolGenerationPresentation(input.runs, input.messages, visibleParts)
    : { messages: input.messages, parts: visibleParts }
  const entries = buildConversationEntries(presentation.messages, presentation.parts, input.runs)
  const activityLabel = conversationActivityLabel(input.runs, input.messages, visibleParts)
  const activeRun =
    input.runs.find((run) => run.status === "running") ??
    input.runs.find((run) => run.status === "pending")
  const activeRunGrouped = Boolean(
    activeRun &&
    entries.some((entry) => entry.type === "turn" && entry.turn.runIds.includes(activeRun.id))
  )
  cacheRef.current = {
    ...input,
    visibleParts,
    entries,
    visiblePartIds: new Set(visibleParts.map((part) => part.id)),
    lastAssistantMessageId: findLastAssistantMessageId(entries),
    activityLabel,
    activeRun,
    activeRunGrouped,
  }
  return { entries, activityLabel, activeRun, activeRunGrouped }
}

function findSingleTextAppend(
  previous: DesktopSessionPart[],
  next: DesktopSessionPart[]
): DesktopSessionPart | null | undefined {
  if (previous.length !== next.length) return undefined
  let updated: DesktopSessionPart | undefined
  for (let index = 0; index < previous.length; index++) {
    const before = previous[index]!
    const after = next[index]!
    if (before === after) continue
    if (updated || !isTextAppend(before, after)) return undefined
    updated = after
  }
  return updated ?? null
}

function isTextAppend(previous: DesktopSessionPart, next: DesktopSessionPart): boolean {
  if (
    (next.type !== "text" && next.type !== "reasoning") ||
    previous.type !== next.type ||
    previous.id !== next.id ||
    previous.sessionId !== next.sessionId ||
    previous.messageId !== next.messageId ||
    previous.seq !== next.seq ||
    previous.status !== next.status ||
    previous.toolUseId !== next.toolUseId ||
    previous.toolName !== next.toolName ||
    previous.input !== next.input ||
    previous.output !== next.output ||
    previous.bodyView !== next.bodyView ||
    previous.isError !== next.isError ||
    previous.metadata !== next.metadata ||
    previous.createdAt !== next.createdAt
  )
    return false
  const previousText = previous.text ?? ""
  return typeof next.text === "string" && next.text.startsWith(previousText)
}

function findLastAssistantMessageId(entries: ConversationEntry[]): string | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!
    if (entry.type !== "turn") continue
    const id = entry.turn.assistantMessages.at(-1)?.id
    if (id) return id
  }
  return undefined
}

function sameReferences<T>(previous: readonly T[], next: readonly T[]): boolean {
  if (previous === next) return true
  if (previous.length !== next.length) return false
  return previous.every((item, index) => item === next[index])
}

function replacePlannedPart(
  plan: ReturnType<typeof planTurnBlocks>,
  part: DesktopSessionPart
): ReturnType<typeof planTurnBlocks> {
  return plan.map((item) => {
    if (item.kind !== "assistant" || item.messageId !== part.messageId) return item
    const index = item.parts.findIndex((candidate) => candidate.id === part.id)
    if (index < 0) return item
    const parts = [...item.parts]
    parts[index] = part
    return { ...item, parts }
  })
}

import { memo, useLayoutEffect, useMemo, useRef, useState } from "react"
import type { OrbState } from "thinking-orbs"

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
import { TurnProcess } from "./turn-process"
import { selectRunNotices } from "./run-notices"
import { pluginPreparationLabel } from "./plugin-preparation-label"
import { TaskDuration } from "../message/task-duration"
import { taskTiming } from "../message/task-timing"
import { conversationActivity, type ActivityStep } from "../message/message-render-model"
import {
  isToolGenerationPresentation,
  withToolGenerationPresentation,
} from "../message/tool-generation-presentation"
import { ConversationScrollerItem as MessageScrollerItem } from "../conversation-scroller"
import { useConversationScroller } from "../conversation-scroll-context"
import { VirtualTranscript, type TranscriptRow } from "./virtual-transcript"
import type {
  DesktopSessionMessage,
  DesktopSessionPart,
  DesktopSessionRun,
  DesktopSessionTask,
} from "@shared/session-types"
import type { ConversationTurn, ConversationEntry } from "../message/conversation-turn-model"
import { AssistantMessageActions, MessageBlock } from "../message/message-block"
import { RunErrorNotice } from "../message/run-error-notice"
import { ContentEntrance } from "../message/content-entrance"

const emptyInputs: DesktopSessionInput[] = []
const emptyTasks: DesktopSessionTask[] = []

interface ConversationTranscriptProps {
  messages: DesktopSessionMessage[]
  inputs?: DesktopSessionInput[]
  parts: DesktopSessionPart[]
  runs: DesktopSessionRun[]
  running: boolean
  canEditLastUserMessage: boolean
  onEditLastUserMessage: (sourceMessageId: string, document: ComposerDocument) => void
  onCopyAssistantMessage: (content: string) => void | Promise<void>
  onForkAssistantMessage?: (messageId: string) => void
  onOpenFile: (path: string, line?: number) => void
  canOpenReview: boolean
  onOpenReview: (path?: string) => void
  onOpenTerminal: (terminalId: string) => void
  showReasoning?: boolean
  tasks?: DesktopSessionTask[]
  onOpenAgents?: (taskId?: string) => void
}

export const ConversationTranscript = memo(function ConversationTranscript({
  messages,
  inputs = emptyInputs,
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
  showReasoning = false,
  tasks = emptyTasks,
  onOpenAgents,
}: ConversationTranscriptProps): React.JSX.Element {
  const modelCache = useRef<TranscriptModelCache | null>(null)
  const { entries, streamingPart, activity, activeRun, activeRunGrouped } = useTranscriptModel(
    modelCache,
    { messages, parts, runs, running, showReasoning }
  )
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
  const preparationLabel = pluginPreparationLabel(activeRun, { messages, parts, inputs, tasks })
  // 这行文字和 orb 动画来自同一个判断，防止文案和动效各说各话。
  const runningActivity: ActivityStep = modelRetry
    ? { label: "等待重试", orb: "breathing" }
    : preparationLabel !== undefined
      ? { label: preparationLabel, orb: "connecting" }
      : (activity ?? { label: "进行中", orb: "working" })
  const turnDataById = useMemo(
    () => buildTurnData(entries, inputs, runs, noticeRuns, running, lastTurn),
    [entries, inputs, runs, noticeRuns, running, lastTurn]
  )

  const rows = useMemo<TranscriptRow[]>(() => {
    const firstUser = entries.find((entry) => entry.type === "turn" && entry.turn.userMessage)
    let navigationId =
      firstUser?.type === "turn"
        ? (firstUser.turn.userMessage!.inputId ?? firstUser.turn.userMessage!.id)
        : undefined
    const result: TranscriptRow[] = []
    for (const entry of entries) {
      if (entry.type === "system") {
        result.push({
          id: entry.system.id,
          messageIds: [entry.system.id],
          navigationId,
          estimateSize: 80,
        })
        continue
      }
      const turn = entry.turn
      const user = turn.userMessage
      if (user) navigationId = user.inputId ?? user.id
      const textLength = [...turn.userParts, ...turn.assistantParts].reduce(
        (sum, part) => sum + (part.text?.length ?? 0),
        0
      )
      result.push({
        id: turn.id,
        navigationId,
        messageIds: [
          user?.inputId,
          user?.id,
          ...turn.assistantMessages.map((message) => message.id),
        ].filter((id): id is string => Boolean(id)),
        estimateSize: Math.min(1200, Math.max(180, Math.ceil(textLength / 70) * 24 + 100)),
      })
    }
    if (modelRetry)
      result.push({
        id: "conversation-model-retry",
        messageIds: [],
        navigationId,
        estimateSize: 80,
      })
    if (running && !activeRunGrouped)
      result.push({
        id: "conversation-running-status",
        messageIds: [],
        navigationId,
        estimateSize: 32,
      })
    if (messages.length === 0 && !running && noticeRuns.length === 0)
      result.push({ id: "conversation-empty", messageIds: [], estimateSize: 320 })
    return result
  }, [entries, modelRetry, running, activeRunGrouped, messages.length, noticeRuns.length])

  // 外层滚动容器随聊天或加载状态重新挂载，这份初始记录只属于当前聊天。
  const [initialPartIds] = useState(() => new Set(parts.map((part) => part.id)))

  return (
    <VirtualTranscript
      rows={rows}
      renderRow={(index) => {
        const row = rows[index]!
        const entry = entries[index]
        if (!entry) {
          if (row.id === "conversation-empty")
            return (
              <MessageScrollerItem>
                <div className="flex min-h-80 items-center justify-center text-sm text-ui-muted">
                  这个会话还没有消息
                </div>
              </MessageScrollerItem>
            )
          if (row.id === "conversation-model-retry" && modelRetry)
            return (
              <MessageScrollerItem messageId={row.id}>
                <ModelRetryNotice retry={modelRetry} />
              </MessageScrollerItem>
            )
          return (
            <MessageScrollerItem messageId={row.id}>
              <TaskDuration
                timing={activeRun ? taskTiming([activeRun]) : { status: "pending" }}
                label={runningActivity.label}
                state={runningActivity.orb}
              />
            </MessageScrollerItem>
          )
        }

        if (entry.type === "system") {
          return (
            <MessageScrollerItem messageId={entry.system.id}>
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
        const data = turnDataById.get(entry.turn.id)!
        const userMessageIsAnchor = entry.turn.userMessage?.id === lastUserMessage?.id
        return (
          <TranscriptTurn
            data={data}
            streamingPart={entry === lastTurn ? streamingPart : undefined}
            userMessageIsAnchor={userMessageIsAnchor}
            canEditUserMessage={canEditLastUserMessage && userMessageIsAnchor}
            runningLabel={data.finished ? undefined : runningActivity.label}
            runningState={data.finished ? undefined : runningActivity.orb}
            initialPartIds={initialPartIds}
            tasks={tasks}
            onOpenAgents={onOpenAgents}
            onEditLastUserMessage={onEditLastUserMessage}
            onCopyAssistantMessage={onCopyAssistantMessage}
            onForkAssistantMessage={onForkAssistantMessage}
            onOpenFile={onOpenFile}
            canOpenReview={canOpenReview}
            onOpenReview={onOpenReview}
            onOpenTerminal={onOpenTerminal}
          />
        )
      }}
    />
  )
})

interface TranscriptTurnData {
  turn: ConversationTurn
  plan: ReturnType<typeof planTurnBlocks>
  inputItems?: DesktopSessionInput["items"]
  turnRuns: DesktopSessionRun[]
  turnFailures: DesktopSessionRun[]
  turnUsageRuns: DesktopSessionRun[]
  timing: ReturnType<typeof taskTiming>
  finished: boolean
  observations: NonNullable<ReturnType<typeof readWorkspaceChangesMetadata>>[]
}

// These indexes and summaries stay unchanged during text-only updates.
function buildTurnData(
  entries: ConversationEntry[],
  inputs: DesktopSessionInput[],
  runs: DesktopSessionRun[],
  noticeRuns: DesktopSessionRun[],
  running: boolean,
  lastTurn: ConversationEntry | undefined
): Map<string, TranscriptTurnData> {
  const runsById = new Map(runs.map((run, index) => [run.id, { run, index }]))
  const inputsById = new Map(inputs.map((input) => [input.id, input]))
  const noticeIds = new Set(noticeRuns.map((run) => run.id))
  const noticesByInputId = new Map<string, DesktopSessionRun[]>()
  for (const run of noticeRuns) {
    if (!run.inputId) continue
    const group = noticesByInputId.get(run.inputId) ?? []
    group.push(run)
    noticesByInputId.set(run.inputId, group)
  }
  const compareRunOrder = (left: DesktopSessionRun, right: DesktopSessionRun): number =>
    runsById.get(left.id)!.index - runsById.get(right.id)!.index
  const result = new Map<string, TranscriptTurnData>()
  for (const entry of entries) {
    if (entry.type !== "turn") continue
    const turn = entry.turn
    const turnRuns = turn.runIds
      .flatMap((id) => {
        const item = runsById.get(id)
        return item ? [item.run] : []
      })
      .sort(compareRunOrder)
    const failures = new Map(
      turnRuns.filter((run) => noticeIds.has(run.id)).map((run) => [run.id, run])
    )
    for (const run of noticesByInputId.get(turn.inputId ?? "") ?? []) failures.set(run.id, run)
    const timing = taskTiming(turnRuns)
    result.set(turn.id, {
      turn,
      plan: planTurnBlocks(turn, { streaming: running && entry === lastTurn }),
      inputItems: turn.userMessage?.inputId
        ? inputsById.get(turn.userMessage.inputId)?.items
        : undefined,
      turnRuns,
      turnFailures: [...failures.values()].sort(compareRunOrder),
      turnUsageRuns: import.meta.env.DEV
        ? turnRuns.filter((run) => readSessionModelUsage(run.metadata)?.incomplete)
        : [],
      timing,
      finished: Boolean(timing && timing.status !== "pending" && timing.status !== "running"),
      observations: turnRuns.flatMap((run) => {
        const observation = readWorkspaceChangesMetadata(run.metadata.workspaceChanges)
        return observation ? [observation] : []
      }),
    })
  }
  return result
}

type TranscriptTurnProps = Pick<
  ConversationTranscriptProps,
  | "onEditLastUserMessage"
  | "onCopyAssistantMessage"
  | "onForkAssistantMessage"
  | "onOpenFile"
  | "canOpenReview"
  | "onOpenReview"
  | "onOpenTerminal"
  | "onOpenAgents"
> & {
  data: TranscriptTurnData
  streamingPart?: DesktopSessionPart
  userMessageIsAnchor: boolean
  canEditUserMessage: boolean
  runningLabel?: string
  runningState?: OrbState
  initialPartIds: ReadonlySet<string>
  tasks: DesktopSessionTask[]
}

const TranscriptTurn = memo(function TranscriptTurn({
  data,
  streamingPart,
  userMessageIsAnchor,
  canEditUserMessage,
  runningLabel,
  runningState,
  initialPartIds,
  tasks,
  onOpenAgents,
  onEditLastUserMessage,
  onCopyAssistantMessage,
  onForkAssistantMessage,
  onOpenFile,
  canOpenReview,
  onOpenReview,
  onOpenTerminal,
}: TranscriptTurnProps): React.JSX.Element {
  const { turn, turnRuns, timing, finished, turnFailures, turnUsageRuns } = data
  const scroller = useConversationScroller()
  const [animationBaseline] = useState(() =>
    scroller?.presentedTurns.has(turn.id)
      ? new Set([...initialPartIds, ...turn.assistantParts.map((part) => part.id)])
      : initialPartIds
  )
  useLayoutEffect(() => {
    scroller?.presentedTurns.add(turn.id)
  }, [scroller, turn.id])
  const userMessage = turn.userMessage
  const turnPlan = useMemo(
    () => (streamingPart ? replacePlannedPart(data.plan, streamingPart) : data.plan),
    [data.plan, streamingPart]
  )
  const lastAssistantKey = [...turnPlan].reverse().find((item) => item.kind === "assistant")?.key
  const firstAssistantKey = turnPlan.find((item) => item.kind === "assistant")?.key
  return (
    <>
      {userMessage ? (
        <MessageScrollerItem
          messageId={userMessage.inputId ?? userMessage.id}
          scrollAnchor={userMessageIsAnchor}
          className="pt-2"
        >
          <ContentEntrance animate={userMessage.metadata.optimistic === true}>
            <MessageBlock
              message={userMessage}
              inputItems={data.inputItems}
              parts={turn.userParts}
              streaming={false}
              userActions={{
                canEdit: canEditUserMessage,
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
      <TurnProcess
        turnId={turn.id}
        plan={turnPlan}
        timing={timing}
        tasks={tasks}
        canCollapse={
          turnRuns.length > 0 &&
          turnRuns.every((run) => run.status !== "pending" && run.status !== "running") &&
          !turnPlan.some((item) => item.streaming)
        }
      >
        {(items, folded) =>
          items.map((item) =>
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
                {item.key === firstAssistantKey && !folded && finished ? (
                  <TaskDuration timing={timing} placement="header" />
                ) : null}
                <AssistantMessage
                  parts={item.parts}
                  summaryParts={item.summaryParts}
                  observations={data.observations}
                  showObservations={item.key === lastAssistantKey}
                  streaming={item.streaming}
                  initialPartIds={animationBaseline}
                  tasks={tasks}
                  onOpenAgents={onOpenAgents}
                  onOpenFile={onOpenFile}
                  canOpenReview={canOpenReview}
                  onOpenReview={onOpenReview}
                  onOpenTerminal={onOpenTerminal}
                />
                {item.key === lastAssistantKey && !folded && !finished ? (
                  <TaskDuration timing={timing} label={runningLabel} state={runningState} />
                ) : null}
                {item.showActions && !item.parts.some(isToolGenerationPresentation) ? (
                  <AssistantMessageActions
                    message={turn.assistantMessages.at(-1)}
                    content={messageTextContent(
                      folded ? items.flatMap((block) => block.parts) : turn.assistantParts
                    )}
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
          )
        }
      </TurnProcess>
      {lastAssistantKey === undefined ? (
        <>
          {timing ? (
            <MessageScrollerItem messageId={`${turn.id}-duration`}>
              <TaskDuration
                timing={timing}
                label={runningLabel}
                state={runningState}
                placement={finished ? "header" : "footer"}
              />
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
    </>
  )
})

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
  activity?: ActivityStep
  activeRun?: DesktopSessionRun
  activeRunGrouped: boolean
  streamingPart?: DesktopSessionPart
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
  activity?: ActivityStep
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
          (updatedPart.type === "reasoning" && !input.showReasoning)) &&
        (!previous.streamingPart ||
          previous.streamingPart.id === updatedPart.id ||
          !previous.visiblePartIds.has(updatedPart.id)))
    if (canReuse) {
      // 普通重渲染或隐藏思考更新也要保留上次已显示的文本。
      const streamingPart =
        updatedPart && previous.visiblePartIds.has(updatedPart.id)
          ? updatedPart
          : previous.streamingPart
      cacheRef.current = {
        ...input,
        visibleParts: previous.visibleParts,
        entries: previous.entries,
        visiblePartIds: previous.visiblePartIds,
        lastAssistantMessageId: previous.lastAssistantMessageId,
        activity: previous.activity,
        activeRun: previous.activeRun,
        activeRunGrouped: previous.activeRunGrouped,
        streamingPart,
      }
      return {
        entries: previous.entries,
        activity: previous.activity,
        activeRun: previous.activeRun,
        activeRunGrouped: previous.activeRunGrouped,
        streamingPart,
      }
    }
  }

  const visibleParts = visibleTranscriptParts(input.parts, input.showReasoning)
  const presentation = input.running
    ? withToolGenerationPresentation(input.runs, input.messages, visibleParts)
    : { messages: input.messages, parts: visibleParts }
  const entries = buildConversationEntries(presentation.messages, presentation.parts, input.runs)
  const activity = conversationActivity(input.runs, input.messages, visibleParts)
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
    activity,
    activeRun,
    activeRunGrouped,
  }
  return { entries, activity, activeRun, activeRunGrouped }
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

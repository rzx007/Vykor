import { Fragment, useMemo, useState } from "react"
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
  // 外层滚动容器随聊天或加载状态重新挂载，这份初始记录只属于当前聊天。
  const [initialPartIds] = useState(() => new Set(parts.map((part) => part.id)))
  const visibleParts = useMemo(
    () => visibleTranscriptParts(parts, showReasoning),
    [parts, showReasoning]
  )
  const presentation = useMemo(
    () =>
      running
        ? withToolGenerationPresentation(runs, messages, visibleParts)
        : { messages, parts: visibleParts },
    [running, runs, messages, visibleParts]
  )
  const entries = useMemo(
    () => buildConversationEntries(presentation.messages, presentation.parts, runs),
    [presentation, runs]
  )
  const lastTurn = [...entries].reverse().find((entry) => entry.type === "turn")
  const lastUserMessage = [...entries]
    .reverse()
    .flatMap((entry) =>
      entry.type === "turn" && entry.turn.userMessage ? [entry.turn.userMessage] : []
    )[0]
  const noticeRuns = selectRunNotices(runs)
  const modelRetry = useMemo(() => {
    for (const run of runs) {
      if (run.status !== "running" && run.status !== "pending") continue
      const state = readSessionModelRetryState(run.metadata)
      if (state) return state
    }
    return undefined
  }, [runs])
  const activityLabel = useMemo(
    () => conversationActivityLabel(runs, messages, visibleParts),
    [runs, messages, visibleParts]
  )
  const activeRun =
    runs.find((run) => run.status === "running") ?? runs.find((run) => run.status === "pending")
  const activeRunGrouped = Boolean(
    activeRun &&
    entries.some((entry) => entry.type === "turn" && entry.turn.runIds.includes(activeRun.id))
  )
  const runningLabel = modelRetry ? "等待重试" : (activityLabel ?? "进行中")

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
        const turnPlan = planTurnBlocks(entry.turn, {
          streaming: running && entry === lastTurn,
        })
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

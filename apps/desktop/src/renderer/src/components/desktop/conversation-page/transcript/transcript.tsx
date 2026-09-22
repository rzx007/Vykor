import { Fragment, useMemo } from "react"
import type { ComposerDocument } from "@renderer/stores/desktop-session/composer-document"
import type { DesktopSessionInput } from "@shared/session-types"

import { messageTextContent } from "../message/message-content"
import { AssistantMessage } from "../message/assistant-message"
import { buildConversationEntries } from "../message/conversation-turn-model"
import { ContextCompactionDivider } from "../message/context-compaction-divider"
import { visibleTranscriptParts } from "./transcript-visibility"
import { planTurnBlocks } from "./turn-block-plan"
import { selectRunNotices } from "./run-notices"
import { LoadingState } from "@renderer/components/ui/loading-state"
import { MessageScrollerItem } from "@renderer/components/ui/message-scroller"
import type {
  DesktopSessionMessage,
  DesktopSessionPart,
  DesktopSessionRun,
} from "@shared/session-types"
import { AssistantMessageActions, MessageBlock } from "../message/message-block"
import { RunErrorNotice } from "../message/run-error-notice"

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
}): React.JSX.Element {
  const visibleParts = useMemo(
    () => visibleTranscriptParts(parts, showReasoning),
    [parts, showReasoning]
  )
  const entries = useMemo(
    () => buildConversationEntries(messages, visibleParts, runs),
    [messages, visibleParts, runs]
  )
  const lastTurn = [...entries].reverse().find((entry) => entry.type === "turn")
  const lastUserMessage = [...entries]
    .reverse()
    .flatMap((entry) =>
      entry.type === "turn" && entry.turn.userMessage ? [entry.turn.userMessage] : []
    )[0]
  const noticeRuns = selectRunNotices(runs)

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
        return (
          <Fragment key={entry.turn.id}>
            {userMessage ? (
              <MessageScrollerItem messageId={userMessage.inputId ?? userMessage.id} scrollAnchor className="pt-2">
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
              </MessageScrollerItem>
            ) : null}
            {planTurnBlocks(entry.turn, { streaming: running && entry === lastTurn }).map((item) =>
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
                    streaming={item.streaming}
                    onOpenFile={onOpenFile}
                    canOpenReview={canOpenReview}
                    onOpenReview={onOpenReview}
                    onOpenTerminal={onOpenTerminal}
                  />
                  {item.showActions ? (
                    <AssistantMessageActions
                      message={entry.turn.assistantMessages.at(-1)}
                      content={messageTextContent(entry.turn.assistantParts)}
                      disabled={false}
                      onCopy={onCopyAssistantMessage}
                      onFork={onForkAssistantMessage}
                    />
                  ) : null}
                </MessageScrollerItem>
              )
            )}
            {turnFailures.map((run) => (
              <MessageScrollerItem key={run.id} messageId={`run-error-${run.id}`}>
                <RunErrorNotice error={run.error} />
              </MessageScrollerItem>
            ))}
          </Fragment>
        )
      })}
      {running ? (
        <MessageScrollerItem messageId="conversation-running-status">
          <LoadingState label="正在处理" variant="Dots" />
        </MessageScrollerItem>
      ) : null}
    </>
  )
}

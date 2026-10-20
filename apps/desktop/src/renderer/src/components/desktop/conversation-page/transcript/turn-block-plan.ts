import type { DesktopSessionPart } from "@shared/session-types"

import type { ContextCompactionPhase } from "../message/notices/compaction-presentation"
import type { ConversationTurn } from "../message/conversation-turn-model"

export interface TurnBlockPlanItem {
  key: string
  messageId: string
  kind: "assistant" | "divider"
  parts: DesktopSessionPart[]
  /** 折叠只改变展示分组，文件改动摘要仍使用完整来源。 */
  summaryParts?: DesktopSessionPart[]
  streaming: boolean
  showActions: boolean
  phase?: ContextCompactionPhase
}

export function planTurnBlocks(
  turn: ConversationTurn,
  options: { streaming: boolean }
): TurnBlockPlanItem[] {
  const lastAssistantIndex = turn.blocks.reduce(
    (latest, block, index) => (block.kind === "assistant" ? index : latest),
    -1
  )
  return turn.blocks.map((block, index) => {
    if (block.kind === "divider") {
      return {
        key: `${turn.id}-divider-${block.message.id}`,
        messageId: block.message.id,
        kind: "divider" as const,
        parts: block.parts,
        streaming: false,
        showActions: false,
        phase: block.phase,
      }
    }
    const isLastAssistant = index === lastAssistantIndex
    const isStreaming = options.streaming && isLastAssistant
    const firstMessageId = block.messages[0]?.id
    const lastMessageId = block.messages.at(-1)?.id
    return {
      key: firstMessageId ?? `${turn.id}-assistant-${index}`,
      messageId: lastMessageId ?? firstMessageId ?? `${turn.id}-assistant-${index}`,
      kind: "assistant" as const,
      parts: block.parts,
      streaming: isStreaming,
      showActions: isLastAssistant && !options.streaming,
    }
  })
}

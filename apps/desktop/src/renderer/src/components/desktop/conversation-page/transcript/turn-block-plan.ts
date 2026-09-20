import type { DesktopSessionPart } from "@shared/session-types"

import type { ContextCompactionPhase } from "../message/compaction-presentation"
import type { ConversationTurn } from "../message/conversation-turn-model"

export interface TurnBlockPlanItem {
  key: string
  messageId: string
  kind: "assistant" | "divider"
  parts: DesktopSessionPart[]
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
    const isStreaming = options.streaming && index === lastAssistantIndex
    const lastMessageId = block.messages.at(-1)?.id
    return {
      key: lastMessageId ?? `${turn.id}-assistant-${index}`,
      messageId: lastMessageId ?? `${turn.id}-assistant-${index}`,
      kind: "assistant" as const,
      parts: block.parts,
      streaming: isStreaming,
      showActions: !isStreaming,
    }
  })
}

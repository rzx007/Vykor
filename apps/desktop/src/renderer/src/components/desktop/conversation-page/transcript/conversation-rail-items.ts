import type { ConversationEntry } from "../message/conversation-turn-model"
import { messageTextContent } from "../message/message-content"

export interface ConversationRailItem {
  id: string
  label: string
  ariaLabel: string
  prompt: string
  reply: string
  turnIndex: number
  createdAt: number
}

export const CONVERSATION_RAIL_MIN_TURNS = 6
export const CONVERSATION_RAIL_MIN_CONTAINER_WIDTH = 900
export const RAIL_ITEM_MIN_SIZE = 5
export const RAIL_ITEM_MAX_SIZE = 24
export const RAIL_VERTICAL_PADDING = 40

const MAX_LABEL_LENGTH = 64
const MAX_PROMPT_LENGTH = 220
const MAX_REPLY_LENGTH = 320

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max).trimEnd()}…`
}

export function buildConversationRailItems(entries: ConversationEntry[]): ConversationRailItem[] {
  const items: ConversationRailItem[] = []
  for (const entry of entries) {
    if (entry.type !== "turn" || !entry.turn.userMessage) continue
    const userMessage = entry.turn.userMessage
    const prompt = normalizeText(messageTextContent(entry.turn.userParts))
    const reply = normalizeText(messageTextContent(entry.turn.assistantParts))
    const label = truncate(prompt, MAX_LABEL_LENGTH)
    const turnIndex = items.length + 1
    items.push({
      id: userMessage.inputId ?? userMessage.id,
      label: label || "（无文本提问）",
      ariaLabel: `第 ${turnIndex} 轮：${label || "无文本提问"}`,
      prompt: truncate(prompt, MAX_PROMPT_LENGTH) || "（无文本提问）",
      reply: truncate(reply, MAX_REPLY_LENGTH),
      turnIndex,
      createdAt: entry.turn.createdAt,
    })
  }
  return items
}

export function shouldShowConversationRail(itemCount: number, containerWidth: number): boolean {
  if (itemCount < CONVERSATION_RAIL_MIN_TURNS) return false
  if (containerWidth > 0 && containerWidth < CONVERSATION_RAIL_MIN_CONTAINER_WIDTH) return false
  return true
}

/** How tall each tick may be, so a long conversation still fits the pane. */
export function resolveRailItemSize(availableHeight: number, count: number): number {
  if (count <= 0 || availableHeight <= 0) return RAIL_ITEM_MAX_SIZE
  const usable = Math.max(0, availableHeight - RAIL_VERTICAL_PADDING)
  const size = Math.floor(usable / count)
  return Math.min(RAIL_ITEM_MAX_SIZE, Math.max(RAIL_ITEM_MIN_SIZE, size))
}

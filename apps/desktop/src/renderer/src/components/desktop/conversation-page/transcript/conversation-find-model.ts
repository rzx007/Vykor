import { isSupersededModelPart } from "@vykor/application-client"
import type { DesktopSessionMessage, DesktopSessionPart } from "@shared/session-types"

export interface ConversationSearchTarget {
  sessionId: string
  messageId: string
  query: string
}

export interface ConversationSearchMatch {
  messageId: string
  partIds: string[]
  tokens: string[]
}

/** 与全局正文搜索一致：忽略大小写，同一条消息需包含所有关键词。 */
export function findConversationMatches(
  messages: readonly DesktopSessionMessage[],
  parts: readonly DesktopSessionPart[],
  query: string
): ConversationSearchMatch[] {
  const tokens = [...new Set(query.trim().toLowerCase().split(/\s+/).filter(Boolean))]
  if (!tokens.length || query.length > 256) return []
  const byMessage = new Map<string, DesktopSessionPart[]>()
  for (const part of parts) {
    if (part.type !== "text" || !part.text || isSupersededModelPart(part)) continue
    const group = byMessage.get(part.messageId) ?? []
    group.push(part)
    byMessage.set(part.messageId, group)
  }
  return [...messages]
    .sort((a, b) => a.seq - b.seq)
    .flatMap((message) => {
      if (message.role !== "user" && message.role !== "assistant") return []
      const texts = byMessage.get(message.id) ?? []
      const text = texts
        .map((part) => part.text)
        .join("\n")
        .toLowerCase()
      if (!tokens.every((token) => text.includes(token))) return []
      return [
        {
          messageId: message.id,
          tokens,
          partIds: texts
            .filter((part) => tokens.some((token) => part.text!.toLowerCase().includes(token)))
            .map((part) => part.id),
        },
      ]
    })
}

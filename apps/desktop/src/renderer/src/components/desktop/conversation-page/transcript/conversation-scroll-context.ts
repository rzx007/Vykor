import { createContext, useContext, useSyncExternalStore } from "react"
import type { ConversationScrollState } from "./conversation-scroll-state"

export const ConversationScrollContext = createContext<ConversationScrollState | null>(null)

export function useConversationScroller() {
  return useContext(ConversationScrollContext)
}

const subscribeNothing = () => () => {}
export function useConversationSearchMatch(messageId?: string, partIds?: readonly string[]) {
  const state = useConversationScroller()
  return useSyncExternalStore(
    state?.subscribe ?? subscribeNothing,
    () => {
      const match = state?.getSnapshot().searchMatch
      return match &&
        (partIds ? partIds.some((id) => match.partIds.includes(id)) : match.messageId === messageId)
        ? match
        : null
    },
    () => null
  )
}

import { createContext, useContext } from "react"
import type { ConversationScrollState } from "./conversation-scroll-state"

export const ConversationScrollContext = createContext<ConversationScrollState | null>(null)

export function useConversationScroller() {
  return useContext(ConversationScrollContext)
}

import { createContext, useContext, type ReactNode } from "react"

export type MainLayoutContextValue = {
  conversationWorkspace: ReactNode
  startNewConversation: () => void
  openSideChat: (sourceId: string, text: string) => void
}

export const MainLayoutContext = createContext<MainLayoutContextValue | null>(null)

export function useMainLayout(): MainLayoutContextValue {
  const context = useContext(MainLayoutContext)
  if (!context) throw new Error("useMainLayout must be used inside MainLayout")
  return context
}

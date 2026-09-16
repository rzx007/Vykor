import { useEffect } from "react"
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router"

import { useMainLayout } from "@renderer/components/desktop/layout/main-layout"
import { useDesktopSessionStore } from "@renderer/stores/desktop-session"

export const Route = createFileRoute("/_main/")({
  beforeLoad: async () => {
    await useDesktopSessionStore.getState().initialize()
    const activeSessionId = useDesktopSessionStore.getState().activeSessionId
    if (activeSessionId) {
      throw redirect({
        to: "/conversation/$sessionId",
        params: { sessionId: activeSessionId },
        replace: true,
      })
    }
  },
  component: ConversationIndexRoute,
})

function ConversationIndexRoute(): React.JSX.Element {
  const navigate = useNavigate()
  const activeSessionId = useDesktopSessionStore((state) => state.activeSessionId)
  const { conversationWorkspace } = useMainLayout()

  useEffect(() => {
    if (!activeSessionId) return
    void navigate({
      to: "/conversation/$sessionId",
      params: { sessionId: activeSessionId },
      replace: true,
    })
  }, [activeSessionId, navigate])

  return <>{conversationWorkspace}</>
}

import { createFileRoute, useNavigate } from "@tanstack/react-router"

import { useMainLayout } from "@renderer/components/desktop/layout/main-layout"
import { ScheduledPage } from "@renderer/components/desktop/scheduled-page"
import { useDesktopSessionStore } from "@renderer/stores/desktop-session"

export const Route = createFileRoute("/_main/scheduled")({
  beforeLoad: () => useDesktopSessionStore.getState().initialize(),
  component: ScheduledRoute,
})

function ScheduledRoute(): React.JSX.Element {
  const { startNewConversation } = useMainLayout()
  const navigate = useNavigate()

  return (
    <ScheduledPage
      onStartConversation={startNewConversation}
      onOpenConversation={(sessionId) => {
        if (!sessionId) {
          startNewConversation()
          return
        }
        void navigate({ to: "/conversation/$sessionId", params: { sessionId } })
      }}
    />
  )
}

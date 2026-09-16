import { createFileRoute, redirect } from "@tanstack/react-router"

import { useMainLayout } from "@renderer/components/desktop/layout/main-layout"
import { useDesktopSessionStore } from "@renderer/stores/desktop-session"

export const Route = createFileRoute("/_main/conversation/$sessionId")({
  beforeLoad: async ({ params }) => {
    await useDesktopSessionStore.getState().initialize()
    const state = useDesktopSessionStore.getState()
    const sessionExists = [...state.sessions, ...state.archivedSessions].some(
      (session) => session.id === params.sessionId
    )
    if (!sessionExists) throw redirect({ to: "/", replace: true })
    if (state.activeSessionId !== params.sessionId) await state.openSession(params.sessionId)
  },
  component: ConversationRoute,
})

function ConversationRoute(): React.JSX.Element {
  const { conversationWorkspace } = useMainLayout()
  return <>{conversationWorkspace}</>
}

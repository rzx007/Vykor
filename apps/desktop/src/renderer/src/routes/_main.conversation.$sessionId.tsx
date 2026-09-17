import { createFileRoute, redirect } from "@tanstack/react-router"

import { useMainLayout } from "@renderer/components/desktop/layout/main-layout"
import { useDesktopSessionStore } from "@renderer/stores/desktop-session"

export const Route = createFileRoute("/_main/conversation/$sessionId")({
  beforeLoad: async ({ params }) => {
    await useDesktopSessionStore.getState().initialize()
    const state = useDesktopSessionStore.getState()
    if (state.sessionView?.session.id !== params.sessionId) {
      await state.openSession(params.sessionId)
    }
    if (useDesktopSessionStore.getState().sessionView?.session.id !== params.sessionId) {
      throw redirect({ to: "/", replace: true })
    }
  },
  component: ConversationRoute,
})

function ConversationRoute(): React.JSX.Element {
  const { conversationWorkspace } = useMainLayout()
  return <>{conversationWorkspace}</>
}

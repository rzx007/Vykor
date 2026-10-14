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
    // 打开失败时仍保留当前会话及其错误，交给会话页展示；跳回首页会再次跳到同一会话。
    // 只有用户在等待期间切换了会话（或新建对话）时，才跟随最新选择返回首页。
    if (useDesktopSessionStore.getState().activeSessionId !== params.sessionId) {
      throw redirect({ to: "/", replace: true })
    }
  },
  component: ConversationRoute,
})

function ConversationRoute(): React.JSX.Element {
  const { conversationWorkspace } = useMainLayout()
  return <>{conversationWorkspace}</>
}

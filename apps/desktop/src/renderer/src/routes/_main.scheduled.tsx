import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useCallback, useRef } from "react"

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
  const refreshPromiseRef = useRef<Promise<void> | null>(null)
  const refreshQueuedRef = useRef(false)
  const refreshSessionList = useCallback((): Promise<void> => {
    refreshQueuedRef.current = true
    if (refreshPromiseRef.current) return refreshPromiseRef.current
    const refresh = (async () => {
      let lastError: unknown
      while (refreshQueuedRef.current) {
        refreshQueuedRef.current = false
        try {
          const lists = await window.desktop.sessions.list()
          useDesktopSessionStore.setState(lists)
          lastError = undefined
        } catch (cause) {
          lastError = cause
        }
      }
      if (lastError) throw lastError
    })().finally(() => {
      if (refreshPromiseRef.current === refresh) {
        refreshPromiseRef.current = null
      }
    })
    refreshPromiseRef.current = refresh
    return refresh
  }, [])
  const openConversation = useCallback(
    async (sessionId: string): Promise<void> => {
      await useDesktopSessionStore.getState().openSession(sessionId)
      if (useDesktopSessionStore.getState().sessionView?.session.id !== sessionId) {
        throw new Error("会话已删除或不可用")
      }
      await navigate({ to: "/conversation/$sessionId", params: { sessionId } })
    },
    [navigate]
  )

  return (
    <ScheduledPage
      onStartConversation={startNewConversation}
      onOpenConversation={openConversation}
      onSessionListChanged={refreshSessionList}
    />
  )
}

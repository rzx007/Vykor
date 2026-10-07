import { useEffect } from "react"
import { createRootRoute, Outlet, useNavigate, useRouterState } from "@tanstack/react-router"
import { markStartupOverlayReady } from "@renderer/startup-overlay"
import { toast } from "@renderer/lib/toast"

import { DesktopSessionEventBridge } from "@renderer/components/desktop/desktop-session-event-bridge"
import { shouldAttachDesktopSessionEvents } from "@renderer/components/desktop/desktop-session-event-bridge-path"
import { DesktopToastHost } from "@renderer/components/desktop/desktop-toast-host"
import { ScopedOperationError } from "@renderer/components/desktop/conversation-page/session/scoped-operation-errors"
import { useDesktopSessionStore } from "@renderer/stores/desktop-session"
import { selectAppOperationError } from "@renderer/stores/desktop-session/selectors"

export const Route = createRootRoute({
  component: DesktopRoot,
})

function DesktopRoot(): React.JSX.Element {
  const navigate = useNavigate()
  const routeReady = useRouterState({
    select: (state) => state.status === "idle" && !state.isLoading,
  })
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const sessionEventsEnabled = shouldAttachDesktopSessionEvents(pathname)
  const appOperationError = useDesktopSessionStore(selectAppOperationError)

  useEffect(() => {
    if (!sessionEventsEnabled) return
    return window.desktop?.tray?.onNotificationClick?.((sessionId) => {
      void window.desktop.notificationSettings.resolveSession(sessionId).then((session) => {
        if (!session) { toast.info("通知对应的会话已删除。", "原会话不可用，未打开其他任务。"); return undefined }
        return navigate({ to: "/conversation/$sessionId", params: { sessionId: session.id } })
      }).catch(() => toast.error("无法打开通知对应的会话。", "请检查后台连接后重试。"))
    })
  }, [navigate, sessionEventsEnabled])

  useEffect(() => {
    // effect 在页面提交后执行；数据返回、项目检查、会话恢复及重定向均不能提前撤掉遮罩。
    if (routeReady) markStartupOverlayReady()
  }, [routeReady])

  return (
    <>
      <DesktopSessionEventBridge enabled={sessionEventsEnabled} />
      <Outlet />
      <DesktopToastHost />
      {appOperationError ? (
        <div className="fixed inset-x-4 top-4 z-50 mx-auto w-full max-w-190">
          <ScopedOperationError error={appOperationError} />
        </div>
      ) : null}
    </>
  )
}

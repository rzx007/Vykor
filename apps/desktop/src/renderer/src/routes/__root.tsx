import { PluginAppsProvider } from "@renderer/components/desktop/shell/plugin-apps/provider"
import { useEffect } from "react"
import {
  createRootRoute,
  Outlet,
  useNavigate,
  useRouter,
  useRouterState,
} from "@tanstack/react-router"
import { markStartupOverlayReady } from "@renderer/startup-overlay"
import { toast } from "@renderer/lib/toast"

import { DesktopSessionEventBridge } from "@renderer/components/desktop/shell/desktop-session-event-bridge"
import { shouldAttachDesktopSessionEvents } from "@renderer/components/desktop/shell/desktop-session-event-bridge-path"
import { DesktopToastHost } from "@renderer/components/desktop/shell/desktop-toast-host"
import { ScopedOperationError } from "@renderer/components/desktop/conversation-page/session/scoped-operation-errors"
import { useDesktopSessionStore } from "@renderer/stores/desktop-session"
import { selectAppOperationError } from "@renderer/stores/desktop-session/selectors"

export const Route = createRootRoute({
  component: DesktopRoot,
})

function DesktopRoot(): React.JSX.Element {
  const navigate = useNavigate()
  const router = useRouter()
  const routeReady = useRouterState({
    select: (state) => state.status === "idle" && !state.isLoading,
  })
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const sessionEventsEnabled = shouldAttachDesktopSessionEvents(pathname)
  const appOperationError = useDesktopSessionStore(selectAppOperationError)

  useEffect(() => {
    if (!sessionEventsEnabled) return
    let disposed = false
    let clickGeneration = 0
    let navigationGeneration = 0
    const detachNavigation = router.subscribe("onBeforeNavigate", () => {
      navigationGeneration += 1
    })
    const detachClick = window.desktop?.tray?.onNotificationClick?.((sessionId) => {
      const click = ++clickGeneration
      const navigation = navigationGeneration
      const location = router.history.location
      // 查询期间的新点击、页面选择或卸载，都撤销旧通知打开页面的资格。
      const isCurrent = (): boolean =>
        !disposed &&
        click === clickGeneration &&
        navigation === navigationGeneration &&
        location === router.history.location
      void window.desktop.notificationSettings
        .resolveSession(sessionId)
        .then((session) => {
          if (!isCurrent()) return undefined
          if (!session) {
            toast.info("通知对应的会话已删除。", "原会话不可用，未打开其他任务。")
            return undefined
          }
          return navigate({ to: "/conversation/$sessionId", params: { sessionId: session.id } })
        })
        .catch(() => {
          if (isCurrent()) toast.error("无法打开通知对应的会话。", "请检查后台连接后重试。")
        })
    })
    return () => {
      disposed = true
      detachClick?.()
      detachNavigation()
    }
  }, [navigate, router, sessionEventsEnabled])

  useEffect(() => {
    // effect 在页面提交后执行；数据返回、项目检查、会话恢复及重定向均不能提前撤掉遮罩。
    if (routeReady) markStartupOverlayReady()
  }, [routeReady])

  return (
    <PluginAppsProvider>
      <DesktopSessionEventBridge enabled={sessionEventsEnabled} />
      <Outlet />
      <DesktopToastHost />
      {appOperationError ? (
        <div className="fixed inset-x-4 top-4 z-50 mx-auto w-full max-w-190">
          <ScopedOperationError error={appOperationError} />
        </div>
      ) : null}
    </PluginAppsProvider>
  )
}

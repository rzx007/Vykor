import { useEffect } from "react"
import { createRootRoute, Outlet, useRouterState } from "@tanstack/react-router"
import { markStartupOverlayReady } from "@renderer/startup-overlay"

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
  const routeReady = useRouterState({
    select: (state) => state.status === "idle" && !state.isLoading,
  })
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const appOperationError = useDesktopSessionStore(selectAppOperationError)

  useEffect(() => {
    // effect 在页面提交后执行；数据返回、项目检查、会话恢复及重定向均不能提前撤掉遮罩。
    if (routeReady) markStartupOverlayReady()
  }, [routeReady])

  return (
    <>
      <DesktopSessionEventBridge enabled={shouldAttachDesktopSessionEvents(pathname)} />
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

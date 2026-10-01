import { useEffect } from "react"
import { createRootRoute, Outlet, useRouterState } from "@tanstack/react-router"
import { markStartupOverlayReady } from "@renderer/startup-overlay"

import { DesktopSessionEventBridge } from "@renderer/components/desktop/desktop-session-event-bridge"
import { shouldAttachDesktopSessionEvents } from "@renderer/components/desktop/desktop-session-event-bridge-path"
import { DesktopToastHost } from "@renderer/components/desktop/desktop-toast-host"
import { ScopedOperationError } from "@renderer/components/desktop/conversation-page/session/scoped-operation-errors"
import { Spinner } from "@renderer/components/ui/spinner"
import { useDesktopSessionStore } from "@renderer/stores/desktop-session"
import {
  selectAppOperationError,
  selectDaemonStatus,
} from "@renderer/stores/desktop-session/selectors"

export const Route = createRootRoute({
  component: DesktopRoot,
  pendingComponent: DesktopRoutePending,
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

export function DesktopRoutePending(): React.JSX.Element {
  const daemonStatus = useDesktopSessionStore(selectDaemonStatus)

  return (
    <div className="flex h-screen min-w-0 items-center justify-center bg-background px-6 text-foreground">
      <div
        className="desktop-route-pending-content flex max-w-100 flex-col items-center gap-3 text-center"
        aria-live="polite"
      >
        <Spinner className="size-5 text-muted-foreground" />
        <div>
          <p className="text-sm font-medium">正在启动 Desktop</p>
          <p className="mt-1 text-xs text-muted-foreground">{daemonStatus.message}</p>
        </div>
        {daemonStatus.detail ? (
          <p className="text-ui-caption max-w-full truncate text-muted-foreground/80">
            {daemonStatus.detail}
          </p>
        ) : null}
      </div>
    </div>
  )
}

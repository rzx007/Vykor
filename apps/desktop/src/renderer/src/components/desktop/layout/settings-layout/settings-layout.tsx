import { useCallback, useState } from "react"
import { Outlet, useNavigate, useParams, useRouter, useRouterState } from "@tanstack/react-router"
import { Group, Panel, useDefaultLayout, usePanelRef } from "react-resizable-panels"

import {
  settingsSectionLabel,
  settingsSectionSlug,
} from "@renderer/components/desktop/settings-page/settings-navigation"
import { useDesktopShortcuts } from "@renderer/components/desktop/use-desktop-shortcuts"
import { PanelResizeHandle } from "@renderer/components/ui/panel-resize-handle"
import { useDesktopSessionStore } from "@renderer/stores/desktop-session"
import { selectActiveSessionId } from "@renderer/stores/desktop-session/selectors"
import { TitleBar } from "../title-bar"
import { useDesktopWindowChrome } from "../use-desktop-window-chrome"
import { SettingsSidebar } from "./settings-sidebar"

const resizeTargetMinimumSize = { fine: 12, coarse: 28 }
const sidebarDefaultWidth = 288
const sidebarMinimumWidth = 236

export function SettingsLayout(): React.JSX.Element {
  const navigate = useNavigate()
  const router = useRouter()
  const historyIndex = useRouterState({
    select: (state) => state.location.state.__TSR_index,
  })
  const { section } = useParams({ strict: false })
  const selectedSection = settingsSectionLabel(section)
  const activeSessionId = useDesktopSessionStore(selectActiveSessionId)
  const startNewConversation = useDesktopSessionStore((state) => state.startNewConversation)
  const chooseProject = useDesktopSessionStore((state) => state.chooseProject)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const { isMaximized, zoomLevel, zoomIn, zoomOut, resetZoom, minimize, toggleMaximize, close } =
    useDesktopWindowChrome()
  const sidebarPanelRef = usePanelRef()
  const layout = useDefaultLayout({
    id: "desktop-settings-layout-v1",
    panelIds: ["settings-sidebar", "settings-content"],
  })

  const openCurrentConversation = useCallback((): void => {
    if (activeSessionId) {
      void navigate({
        to: "/conversation/$sessionId",
        params: { sessionId: activeSessionId },
      })
      return
    }
    void navigate({ to: "/" })
  }, [activeSessionId, navigate])

  const createConversation = useCallback((): void => {
    void startNewConversation().then(() => navigate({ to: "/" }))
  }, [navigate, startNewConversation])

  const toggleSidebar = useCallback((): void => {
    const panel = sidebarPanelRef.current
    if (!panel) return
    if (panel.isCollapsed()) panel.expand()
    else panel.collapse()
  }, [sidebarPanelRef])

  useDesktopShortcuts({
    newConversation: createConversation,
    chooseProject: () => {
      openCurrentConversation()
      void chooseProject()
    },
    quit: () => void window.desktop.app.quit(),
    toggleSidebar,
    goBack: () => router.history.back(),
    goForward: () => router.history.forward(),
    zoomIn,
    zoomOut,
    resetZoom,
  })

  return (
    <main className="flex h-screen min-h-0 flex-col overflow-hidden bg-shell text-foreground">
      <TitleBar
        sidebarOpen={sidebarOpen}
        panelOpen={false}
        isMaximized={isMaximized}
        hasActiveSession={Boolean(activeSessionId)}
        canGoBack={router.history.canGoBack()}
        canGoForward={historyIndex < router.history.length - 1}
        canOpenPreviousSession={false}
        canOpenNextSession={false}
        zoomLevel={zoomLevel}
        onGoBack={() => router.history.back()}
        onGoForward={() => router.history.forward()}
        onNewConversation={createConversation}
        onChooseProject={() => {
          openCurrentConversation()
          void chooseProject()
        }}
        onCloseConversation={createConversation}
        onOpenPreviousSession={openCurrentConversation}
        onOpenNextSession={openCurrentConversation}
        onToggleSidebar={toggleSidebar}
        onTogglePanel={openCurrentConversation}
        onOpenUtilityTool={openCurrentConversation}
        onZoomIn={zoomIn}
        onZoomOut={zoomOut}
        onResetZoom={resetZoom}
        onMinimize={minimize}
        onToggleMaximize={toggleMaximize}
        onClose={close}
      />
      <Group
        id="desktop-settings"
        orientation="horizontal"
        className="min-h-0 flex-1"
        resizeTargetMinimumSize={resizeTargetMinimumSize}
        defaultLayout={layout.defaultLayout}
        onLayoutChanged={layout.onLayoutChanged}
      >
        <Panel
          id="settings-sidebar"
          panelRef={sidebarPanelRef}
          defaultSize={sidebarDefaultWidth}
          minSize={sidebarMinimumWidth}
          maxSize={420}
          collapsedSize={0}
          collapsible
          groupResizeBehavior="preserve-pixel-size"
          className="h-full min-h-0 overflow-hidden"
          onResize={(size) => setSidebarOpen(size.inPixels > 1)}
        >
          <SettingsSidebar
            selectedSection={selectedSection}
            onSelectSection={(nextSection) =>
              void navigate({
                to: "/settings/$section",
                params: { section: settingsSectionSlug(nextSection) },
              })
            }
            onClose={openCurrentConversation}
          />
        </Panel>
        <PanelResizeHandle label="调整设置侧边栏宽度" />
        <Panel
          id="settings-content"
          minSize={420}
          className="h-full min-h-0"
          style={{ overflow: "visible" }}
        >
          <section className="border-workspace flex h-full min-w-0 overflow-hidden rounded-tl-lg border-t border-l bg-conversation shadow-workspace">
            <Outlet />
          </section>
        </Panel>
      </Group>
    </main>
  )
}

import { useCallback, useEffect, useRef, useState } from "react"
import { Outlet, useNavigate, useParams, useRouter, useRouterState } from "@tanstack/react-router"
import { Group, Panel, type Layout, type LayoutChangedMeta, usePanelRef } from "react-resizable-panels"

import {
  settingsSectionLabel,
  settingsSectionSlug,
} from "@renderer/components/desktop/settings-page/settings-navigation"
import { useDesktopShortcuts } from "@renderer/components/desktop/use-desktop-shortcuts"
import { PanelResizeHandle } from "@renderer/components/ui/panel-resize-handle"
import { cn } from "@renderer/lib/utils"
import { useDesktopSessionStore } from "@renderer/stores/desktop-session"
import { selectActiveSessionId } from "@renderer/stores/desktop-session/selectors"
import { TitleBar } from "../title-bar"
import { useDesktopWindowChrome } from "../use-desktop-window-chrome"
import { beginPanelToggleTransition } from "../main-layout/panel-toggle-transition"
import { createPanelWidthStore, shouldPersistPanelWidth } from "../panel-width-store"
import { SettingsSidebar } from "./settings-sidebar"

const resizeTargetMinimumSize = { fine: 12, coarse: 28 }
const sidebarWidthStore = createPanelWidthStore({
  storageKey: "vykor.desktop.settings-sidebar-width-px",
  defaultPx: 288,
  minPx: 236,
  maxPx: 420,
})

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
  const shellRef = useRef<HTMLDivElement>(null)
  const sidebarGroupElementRef = useRef<HTMLDivElement | null>(null)
  const sidebarTransitionCancelRef = useRef<(() => void) | null>(null)
  const [sidebarDefaultSizePx] = useState(() => sidebarWidthStore.resolveDefault())
  const [sidebarMasked, setSidebarMasked] = useState(false)

  useEffect(
    () => () => {
      sidebarTransitionCancelRef.current?.()
      sidebarTransitionCancelRef.current = null
    },
    []
  )

  const handleLayoutChanged = useCallback(
    (_layout: Layout, meta: LayoutChangedMeta): void => {
      const size = sidebarPanelRef.current?.getSize()
      if (!size || !shouldPersistPanelWidth(meta, size.inPixels)) return
      sidebarWidthStore.persist(size.inPixels)
    },
    [sidebarPanelRef]
  )

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
    if (!panel) {
      setSidebarOpen((current) => !current)
      return
    }
    sidebarTransitionCancelRef.current?.()
    sidebarTransitionCancelRef.current = beginPanelToggleTransition(sidebarGroupElementRef.current)
    const collapsing = !panel.isCollapsed()
    setSidebarMasked(collapsing)
    if (collapsing) panel.collapse()
    else panel.expand()
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
    <main
      ref={shellRef}
      className="flex h-screen min-h-0 flex-col overflow-hidden bg-shell text-foreground"
      style={
        {
          "--settings-sidebar-content-width": `${sidebarDefaultSizePx}px`,
        } as React.CSSProperties
      }
    >
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
        elementRef={sidebarGroupElementRef}
        resizeTargetMinimumSize={resizeTargetMinimumSize}
        onLayoutChanged={handleLayoutChanged}
      >
        <Panel
          id="settings-sidebar"
          panelRef={sidebarPanelRef}
          defaultSize={sidebarDefaultSizePx}
          minSize={sidebarWidthStore.minPx}
          maxSize={sidebarWidthStore.maxPx}
          collapsedSize={0}
          collapsible
          groupResizeBehavior="preserve-pixel-size"
          className="h-full min-h-0 overflow-hidden"
          style={{ overflow: "hidden" }}
          onResize={(size) => {
            if (
              size.inPixels > 1 &&
              !sidebarGroupElementRef.current?.hasAttribute("data-panel-animating")
            ) {
              shellRef.current?.style.setProperty(
                "--settings-sidebar-content-width",
                `${size.inPixels}px`
              )
            }
            setSidebarOpen(size.inPixels > 1)
          }}
        >
          <div
            className="relative h-full"
            style={{ width: "var(--settings-sidebar-content-width)" }}
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
            <div
              aria-hidden="true"
              className={cn(
                "pointer-events-none absolute inset-0 z-20 bg-linear-to-l from-background/60 to-transparent transition-opacity duration-200 ease-out",
                sidebarMasked ? "opacity-100" : "opacity-0"
              )}
            />
          </div>
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

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Outlet, useNavigate, useRouter, useRouterState } from "@tanstack/react-router"
import {
  Group,
  Panel,
  type Layout,
  useDefaultLayout,
  useGroupRef,
  usePanelRef,
} from "react-resizable-panels"

import { ConversationPane } from "@renderer/components/desktop/conversation-page"
import { ScopedOperationError } from "@renderer/components/desktop/conversation-page/session/scoped-operation-errors"
import { defaultSettingsSection } from "@renderer/components/desktop/settings-page/settings-navigation"
import { useDesktopShortcuts } from "@renderer/components/desktop/use-desktop-shortcuts"
import { PanelResizeHandle } from "@renderer/components/ui/panel-resize-handle"
import {
  attachDesktopSessionEvents,
  useDesktopSessionStore,
} from "@renderer/stores/desktop-session"
import {
  selectActiveSessionId,
  selectProjectOperationError,
  selectSessions,
} from "@renderer/stores/desktop-session/selectors"
import { TitleBar } from "../title-bar"
import { useDesktopWindowChrome } from "../use-desktop-window-chrome"
import { MainLayoutContext } from "./main-layout-context"
import { Sidebar } from "./sidebar"
import { UtilityPanel, useUtilityPanelController } from "./utility-panel"

const resizeTargetMinimumSize = { fine: 12, coarse: 28 }
const sidebarDefaultWidth = 288
const sidebarMinimumWidth = 266
const conversationMinimumWidth = 350
const utilityMinimumWidth = 320
const workspaceMinimumWidth = conversationMinimumWidth + utilityMinimumWidth
const defaultWorkspaceLayout: Layout = { conversation: 40, utility: 60 }
const collapsedWorkspaceLayout: Layout = { conversation: 100, utility: 0 }

function isOpenWorkspaceLayout(layout: Layout | null | undefined): layout is Layout {
  return Number(layout?.conversation) > 5 && Number(layout?.utility) > 5
}

export function MainLayout(): React.JSX.Element {
  const navigate = useNavigate()
  const router = useRouter()
  const historyIndex = useRouterState({
    select: (state) => state.location.state.__TSR_index,
  })
  const startNewConversation = useDesktopSessionStore((state) => state.startNewConversation)
  const chooseProject = useDesktopSessionStore((state) => state.chooseProject)
  const sessions = useDesktopSessionStore(selectSessions)
  const activeSessionId = useDesktopSessionStore(selectActiveSessionId)
  const selectedProjectId = useDesktopSessionStore((state) => state.selectedProject?.id ?? null)
  const selectedProjectOperationError = useDesktopSessionStore((state) =>
    selectProjectOperationError(state, state.selectedProject?.id ?? null)
  )
  const selectedProjectGit = useDesktopSessionStore((state) => state.selectedProjectGit)
  const refreshSelectedProjectGit = useDesktopSessionStore(
    (state) => state.refreshSelectedProjectGit
  )
  const sessionIds = useMemo(() => sessions.map((session) => session.id), [sessions])
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const sidebarPanelRef = usePanelRef()
  const conversationPanelRef = usePanelRef()
  const utilityPanelRef = usePanelRef()
  const workspaceGroupRef = useGroupRef()
  const contentRef = useRef<HTMLDivElement>(null)
  const { isMaximized, zoomLevel, zoomIn, zoomOut, resetZoom, minimize, toggleMaximize, close } =
    useDesktopWindowChrome()
  const outerLayout = useDefaultLayout({
    id: "desktop-shell-layout",
    panelIds: ["sidebar", "workspace"],
  })
  const workspaceLayout = useDefaultLayout({
    id: "desktop-workspace-layout",
    panelIds: ["conversation", "utility"],
  })
  const workspaceDefaultLayout = isOpenWorkspaceLayout(workspaceLayout.defaultLayout)
    ? workspaceLayout.defaultLayout
    : defaultWorkspaceLayout
  const utilityPanel = useUtilityPanelController({
    activeSessionId,
    selectedProjectId,
    sessionIds,
    sidebarOpen,
    defaultLayout: workspaceDefaultLayout,
    collapsedLayout: collapsedWorkspaceLayout,
    sidebarPanelRef,
    conversationPanelRef,
    utilityPanelRef,
    workspaceGroupRef,
    onWorkspaceLayoutChanged: workspaceLayout.onLayoutChanged,
  })
  const panelOpen = utilityPanel.open
  const utilityMaximized = utilityPanel.maximized
  const visiblePanelLayout = utilityPanel.visibleLayout
  const togglePanel = utilityPanel.toggle
  const openWorkspaceFile = utilityPanel.openFile
  const openReview = utilityPanel.openReview
  const openTerminal = utilityPanel.openTerminal
  const openUtilityTool = utilityPanel.openTool

  useEffect(() => {
    const detach = attachDesktopSessionEvents()
    return detach
  }, [])

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const sidebarSize = sidebarPanelRef.current?.getSize()
      if (!sidebarSize) return
      contentRef.current?.style.setProperty("--sidebar-width", `${sidebarSize.inPixels}px`)
      setSidebarOpen((current) => {
        const nextOpen = sidebarSize.inPixels > 1
        return current === nextOpen ? current : nextOpen
      })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [sidebarPanelRef])

  const toggleSidebar = useCallback((): void => {
    const panel = sidebarPanelRef.current
    if (!panel) {
      setSidebarOpen((current) => !current)
      return
    }

    if (panel.isCollapsed()) {
      panel.expand()
    } else {
      panel.collapse()
    }
  }, [sidebarPanelRef])

  const openConversationRoute = useCallback(
    (destination: string | null | undefined): void => {
      const sessionId = destination === undefined ? activeSessionId : destination
      if (sessionId) {
        void navigate({
          to: "/conversation/$sessionId",
          params: { sessionId },
        })
      } else {
        void navigate({ to: "/" })
      }
    },
    [activeSessionId, navigate]
  )

  const startNewConversationRoute = useCallback((): void => {
    void startNewConversation().then(() => navigate({ to: "/" }))
  }, [navigate, startNewConversation])

  const showCurrentConversation = useCallback((): void => {
    openConversationRoute(undefined)
  }, [openConversationRoute])

  const requestOpenReview = useCallback(
    (path?: string): void => {
      void refreshSelectedProjectGit({ force: true }).then((git) => {
        if (git) openReview(path)
      })
    },
    [openReview, refreshSelectedProjectGit]
  )

  const activeSessionIndex = sessions.findIndex((session) => session.id === activeSessionId)
  const previousSession = activeSessionIndex > 0 ? sessions[activeSessionIndex - 1] : null
  const nextSession =
    activeSessionIndex >= 0 && activeSessionIndex < sessions.length - 1
      ? sessions[activeSessionIndex + 1]
      : null

  const openPreviousSession = useCallback((): void => {
    if (previousSession) openConversationRoute(previousSession.id)
  }, [openConversationRoute, previousSession])

  const openNextSession = useCallback((): void => {
    if (nextSession) openConversationRoute(nextSession.id)
  }, [nextSession, openConversationRoute])

  useDesktopShortcuts({
    newConversation: startNewConversationRoute,
    chooseProject: () => {
      showCurrentConversation()
      void chooseProject()
    },
    closeConversation: () => {
      if (activeSessionId) startNewConversationRoute()
    },
    quit: () => void window.desktop.app.quit(),
    toggleSidebar,
    togglePanel,
    openBrowser: () => openUtilityTool("browser"),
    openFiles: () => openUtilityTool("files"),
    openTerminal: () => openUtilityTool("terminal"),
    previousSession: openPreviousSession,
    nextSession: openNextSession,
    goBack: () => router.history.back(),
    goForward: () => router.history.forward(),
    zoomIn,
    zoomOut,
    resetZoom,
  })

  const renderPage = (sidebar: React.ReactNode): React.JSX.Element => (
    <div
      ref={contentRef}
      className="relative min-h-0 flex-1 overflow-visible"
      style={{ "--sidebar-width": `${sidebarDefaultWidth}px` } as React.CSSProperties}
    >
      <div
        aria-hidden="true"
        className="workspace-top-shadow pointer-events-none absolute top-0 right-0 z-20 h-px"
        style={{ left: "calc(var(--sidebar-width) + 1px)" }}
      />
      <Group
        id="desktop-shell"
        orientation="horizontal"
        className="h-full min-h-0"
        resizeTargetMinimumSize={resizeTargetMinimumSize}
        defaultLayout={outerLayout.defaultLayout}
        onLayoutChanged={outerLayout.onLayoutChanged}
      >
        <Panel
          id="sidebar"
          panelRef={sidebarPanelRef}
          defaultSize={sidebarDefaultWidth}
          minSize={sidebarMinimumWidth}
          maxSize={420}
          collapsedSize={0}
          collapsible
          groupResizeBehavior="preserve-pixel-size"
          className="h-full min-h-0 overflow-hidden"
          onResize={(size) => {
            contentRef.current?.style.setProperty("--sidebar-width", `${size.inPixels}px`)
            const nextOpen = size.inPixels > 1
            setSidebarOpen((current) => (current === nextOpen ? current : nextOpen))
          }}
        >
          {sidebar}
        </Panel>
        <PanelResizeHandle label="调整侧边栏宽度" />
        <Panel
          id="workspace"
          minSize={workspaceMinimumWidth}
          className="h-full min-h-0"
          style={{ overflow: "visible" }}
        >
          <section className="border-workspace flex h-full min-w-0 overflow-hidden rounded-tl-lg border-t border-l bg-conversation shadow-workspace">
            <Outlet />
          </section>
        </Panel>
      </Group>
    </div>
  )

  const renderConversationWorkspace = (): React.JSX.Element => (
    <Group
      id="desktop-workspace"
      groupRef={workspaceGroupRef}
      orientation="horizontal"
      className="h-full min-h-0 w-full"
      resizeTargetMinimumSize={resizeTargetMinimumSize}
      defaultLayout={
        utilityMaximized
          ? { conversation: 0, utility: 100 }
          : panelOpen
            ? visiblePanelLayout
            : collapsedWorkspaceLayout
      }
      onLayoutChanged={utilityPanel.handleLayoutChanged}
    >
      <Panel
        id="conversation"
        panelRef={conversationPanelRef}
        defaultSize="100%"
        minSize={utilityMaximized ? 0 : conversationMinimumWidth}
        collapsedSize={0}
        collapsible
        className="h-full min-h-0 overflow-hidden"
      >
        <ConversationPane
          panelOpen={panelOpen}
          onTogglePanel={togglePanel}
          onOpenFile={openWorkspaceFile}
          canOpenReview={selectedProjectGit}
          onOpenReview={requestOpenReview}
          onOpenTerminal={openTerminal}
          onOpenAgents={() => openUtilityTool("agents")}
        />
      </Panel>
      {!utilityMaximized && <PanelResizeHandle label="调整工具面板宽度" />}
      <Panel
        id="utility"
        panelRef={utilityPanelRef}
        defaultSize={panelOpen ? `${visiblePanelLayout.utility ?? 60}%` : 0}
        minSize={panelOpen || utilityMaximized ? utilityMinimumWidth : 0}
        maxSize={utilityMaximized ? "100%" : "70%"}
        collapsedSize={0}
        collapsible
        groupResizeBehavior="preserve-pixel-size"
        className="h-full min-h-0 overflow-hidden"
        onResize={(size) => {
          utilityPanel.handlePanelResize(size.inPixels)
        }}
      >
        <UtilityPanel
          key={utilityPanel.instanceKey}
          scopeId={utilityPanel.scopeId}
          open={panelOpen}
          maximized={utilityMaximized}
          onToggleMaximized={utilityPanel.toggleMaximized}
          onClose={utilityPanel.collapse}
          fileOpenRequest={utilityPanel.fileOpenRequest}
          reviewOpenRequest={utilityPanel.reviewOpenRequest}
          terminalOpenRequest={utilityPanel.terminalOpenRequest}
          toolOpenRequest={utilityPanel.toolOpenRequest}
          onOpenFile={openWorkspaceFile}
          onOpenReview={requestOpenReview}
          onOpenTerminal={openTerminal}
        />
      </Panel>
    </Group>
  )

  return (
    <main className="relative flex h-screen min-h-0 flex-col overflow-hidden bg-shell text-foreground">
      <TitleBar
        sidebarOpen={sidebarOpen}
        panelOpen={panelOpen}
        isMaximized={isMaximized}
        hasActiveSession={Boolean(activeSessionId)}
        canGoBack={router.history.canGoBack()}
        canGoForward={historyIndex < router.history.length - 1}
        canOpenPreviousSession={Boolean(previousSession)}
        canOpenNextSession={Boolean(nextSession)}
        zoomLevel={zoomLevel}
        onGoBack={() => router.history.back()}
        onGoForward={() => router.history.forward()}
        onNewConversation={startNewConversationRoute}
        onChooseProject={() => {
          showCurrentConversation()
          void chooseProject()
        }}
        onCloseConversation={startNewConversationRoute}
        onOpenPreviousSession={openPreviousSession}
        onOpenNextSession={openNextSession}
        onToggleSidebar={toggleSidebar}
        onTogglePanel={togglePanel}
        onOpenUtilityTool={openUtilityTool}
        onZoomIn={zoomIn}
        onZoomOut={zoomOut}
        onResetZoom={resetZoom}
        onMinimize={minimize}
        onToggleMaximize={toggleMaximize}
        onClose={close}
      />
      {selectedProjectOperationError ? (
        <div className="absolute inset-x-4 top-12 z-40 mx-auto w-full max-w-190">
          <ScopedOperationError error={selectedProjectOperationError} />
        </div>
      ) : null}
      <MainLayoutContext.Provider
        value={{
          conversationWorkspace: renderConversationWorkspace(),
          startNewConversation: startNewConversationRoute,
        }}
      >
        {renderPage(
          <Sidebar
            open={sidebarOpen}
            onOpenScheduled={() => void navigate({ to: "/scheduled" })}
            onOpenPlugins={() => void navigate({ to: "/plugins" })}
            onOpenConversation={openConversationRoute}
            onOpenSettings={() =>
              void navigate({
                to: "/settings/$section",
                params: { section: defaultSettingsSection },
              })
            }
          />
        )}
      </MainLayoutContext.Provider>
    </main>
  )
}

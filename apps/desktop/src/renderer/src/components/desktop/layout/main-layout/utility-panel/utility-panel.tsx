import { MessageCirclePlus } from "lucide-react"
import type * as React from "react"
import { useCallback, useEffect, useRef, useState } from "react"

import { BrowserTool, type BrowserToolTab } from "@renderer/components/desktop/tools/browser-tool"
import { toLocalFileUrl } from "@renderer/components/desktop/tools/browser-navigation"
import type { UtilityToolRequest } from "./utility-panel-tabs"
import { FilesTool } from "@renderer/components/desktop/tools/files-tool"
import { getFileIcon } from "@renderer/components/desktop/tools/file-icons"
import {
  mergeFileViewerTabs,
  type FileViewerTab,
} from "@renderer/components/desktop/tools/file-viewer"
import { PlaceholderTool } from "@renderer/components/desktop/tools/placeholder-tool"
import { ReviewTool } from "@renderer/components/desktop/tools/review-tool"
import { TerminalTool } from "@renderer/components/desktop/tools/terminal/terminal-tool"
import { AgentsTool } from "@renderer/components/desktop/tools/agents/agents-tool"
import type {
  TerminalPanelCommand,
  TerminalSessionTabInfo,
} from "@renderer/components/desktop/tools/terminal/terminal-tool"
import { cn } from "@renderer/lib/utils"
import {
  selectActiveWorkspaceProject,
  useDesktopSessionStore,
} from "@renderer/stores/desktop-session"
import { prepareFileOpenRequest } from "./file-open-request"
import {
  readPersistedUtilityFileTabs,
  writePersistedUtilityFileTabs,
} from "./utility-panel-repository"
import { createBrowserTab, type PersistedFileTabsByScope } from "./utility-panel-state"
import { EmptyUtilityPanelState, UtilityPanelTabStrip } from "./utility-panel-tab-strip"
import {
  utilityToolMeta,
  utilityToolOrder,
  type UtilityTab,
  type UtilityTool,
} from "./utility-panel-tabs"
import { useUtilityPanelRuntime } from "./use-utility-panel-runtime"

type UtilityPanelProps = {
  scopeId: string
  open: boolean
  maximized: boolean
  onToggleMaximized: () => void
  onClose: () => void
  fileOpenRequest: { id: number; path: string; line?: number } | null
  reviewOpenRequest: { id: number; path?: string } | null
  terminalOpenRequest: { id: number; terminalId: string } | null
  toolOpenRequest: { id: number; tool: UtilityToolRequest } | null
  onOpenFile: (path: string, line?: number) => void
  onOpenReview: (path?: string) => void
  onOpenTerminal: (terminalId: string) => void
}

const filesTabId = "files-tab"
const unavailableTerminalTabId = "terminal-tab:unavailable"

export function UtilityPanel({
  scopeId,
  open,
  maximized,
  onToggleMaximized,
  onClose,
  fileOpenRequest,
  reviewOpenRequest,
  terminalOpenRequest,
  toolOpenRequest,
  onOpenFile,
  onOpenReview,
  onOpenTerminal,
}: UtilityPanelProps): React.JSX.Element {
  const {
    state: {
      tabs,
      browserTabs,
      fileTabs,
      fileProjectPath,
      activeFilePath,
      loadingFilePath,
      activeTabId,
      terminalMounted,
      handledFileRequestId,
      handledToolRequestId,
    },
    fileTabsRef,
    setTabs,
    setBrowserTabs,
    setFileTabs,
    setFileProjectPath,
    setActiveFilePath,
    setLoadingFilePath,
    setActiveTabId,
    setTerminalMounted,
    setHandledFileRequestId,
    setHandledToolRequestId,
  } = useUtilityPanelRuntime(scopeId)
  const [terminalCommands, setTerminalCommands] = useState<TerminalPanelCommand[]>([])
  const terminalCommandSequenceRef = useRef(0)
  const handledReviewRequestRef = useRef<number | null>(null)
  const [persistedFileTabs, setPersistedFileTabs] = useState<PersistedFileTabsByScope>(
    readPersistedUtilityFileTabs
  )
  const workspaceProject = useDesktopSessionStore(selectActiveWorkspaceProject)
  const selectedProjectPath = workspaceProject?.path
  const activeSessionId = useDesktopSessionStore((state) => state.activeSessionId)
  const selectedProjectGit = useDesktopSessionStore((state) => state.selectedProjectGit)
  const selectedProjectAvailable = workspaceProject?.available ?? false
  const availableTools = selectedProjectGit
    ? utilityToolOrder
    : utilityToolOrder.filter((tool) => tool !== "review")
  const persistedFileState = selectedProjectPath ? persistedFileTabs[scopeId] : undefined
  const fileStateVisible = fileProjectPath === (selectedProjectPath ?? null)
  const visibleFileTabs = fileTabs.filter(
    (tab) => (tab.projectPath ?? null) === (selectedProjectPath ?? null)
  )
  const visibleTabs = tabs.filter(
    (tab) =>
      (!tab.projectPath || tab.projectPath === selectedProjectPath) &&
      (selectedProjectGit || tab.tool !== "review")
  )
  const visibleActiveFilePath =
    fileStateVisible || visibleTabs.some((tab) => tab.filePath === activeFilePath)
      ? activeFilePath
      : null
  const visibleLoadingFilePath =
    fileStateVisible || visibleTabs.some((tab) => tab.filePath === loadingFilePath)
      ? loadingFilePath
      : null
  const activeTab = visibleTabs.find((tab) => tab.id === activeTabId) ?? visibleTabs[0]
  const terminalCommand = terminalCommands[0] ?? null
  const pendingTerminal =
    Boolean(terminalOpenRequest) ||
    terminalCommands.some((command) => command.type === "ensure" || command.type === "create")

  useEffect(() => {
    if (!fileOpenRequest || handledFileRequestId === fileOpenRequest.id) return
    const prepared = prepareFileOpenRequest(fileOpenRequest.path, selectedProjectPath)
    if (prepared.placeholderPath) return
    const timer = window.setTimeout(() => {
      setHandledFileRequestId(fileOpenRequest.id)
      setTabs((current) => {
        const existing = current.find((tab) => tab.id === filesTabId || tab.tool === "files")
        if (existing) {
          setActiveTabId(existing.id)
          return current
        }
        setActiveTabId(filesTabId)
        return [...current, { id: filesTabId, tool: "files", title: utilityToolMeta.files.label }]
      })
    }, 0)
    return () => window.clearTimeout(timer)
  }, [
    fileOpenRequest,
    handledFileRequestId,
    selectedProjectPath,
    setActiveTabId,
    setHandledFileRequestId,
    setTabs,
  ])

  useEffect(() => {
    if (!terminalOpenRequest) return
    const timer = window.setTimeout(() => setTerminalMounted(true), 0)
    return () => window.clearTimeout(timer)
  }, [setTerminalMounted, terminalOpenRequest])

  useEffect(() => {
    if (!selectedProjectGit) return
    if (!reviewOpenRequest || handledReviewRequestRef.current === reviewOpenRequest.id) return
    handledReviewRequestRef.current = reviewOpenRequest.id
    const timer = window.setTimeout(() => {
      const id = toolTabId("review")
      setTabs((current) => {
        const existing = current.find((tab) => tab.id === id)
        if (existing) {
          setActiveTabId(existing.id)
          return current
        }
        setActiveTabId(id)
        return [...current, { id, tool: "review", title: utilityToolMeta.review.label }]
      })
    }, 0)
    return () => window.clearTimeout(timer)
  }, [reviewOpenRequest, selectedProjectGit, setActiveTabId, setTabs])

  useEffect(() => {
    if (selectedProjectGit) return
    const timer = window.setTimeout(() => {
      setTabs((current) => {
        if (!current.some((tab) => tab.tool === "review")) return current
        const nextTabs = current.filter((tab) => tab.tool !== "review")
        if (activeTabId === toolTabId("review")) setActiveTabId(nextTabs[0]?.id ?? "")
        return nextTabs
      })
    }, 0)
    return () => window.clearTimeout(timer)
  }, [activeTabId, selectedProjectGit, setActiveTabId, setTabs])

  const openBrowserTab = useCallback(
    (url: string | null = null, title = "新标签页"): void => {
      const id = `browser-tab-${Date.now()}-${Math.random().toString(16).slice(2)}`
      const tab = createBrowserTab(id, url, title)
      setBrowserTabs((current) => [...current, tab])
      setTabs((current) => [...current, { id, tool: "browser", title: tab.title }])
      setActiveTabId(id)
    },
    [setActiveTabId, setBrowserTabs, setTabs]
  )

  const addTab = useCallback(
    (tool: UtilityTool): void => {
      if (tool === "terminal") {
        setTerminalMounted(true)
        if (!selectedProjectPath || !selectedProjectAvailable) {
          const id = unavailableTerminalTabId
          setTabs((current) =>
            current.some((tab) => tab.id === id)
              ? current
              : [...current, { id, tool, title: utilityToolMeta.terminal.label }]
          )
          setActiveTabId(id)
          return
        }
        setTerminalCommands((commands) => [
          ...commands,
          {
            id: ++terminalCommandSequenceRef.current,
            type: "create",
          },
        ])
        return
      }

      if (tool === "browser") {
        openBrowserTab()
        return
      }

      if (tool === "files") {
        setFileProjectPath(selectedProjectPath ?? null)
        setTabs((current) => {
          const emptyFilesTab = current.find((tab) => tab.id === filesTabId)
          if (emptyFilesTab) {
            setActiveTabId(emptyFilesTab.id)
            return current
          }
          const existingFileTab =
            current.find(
              (tab) =>
                tab.tool === "files" &&
                tab.filePath &&
                tab.filePath === activeFilePath &&
                tab.projectPath === selectedProjectPath
            ) ??
            current.find(
              (tab) =>
                tab.tool === "files" && tab.filePath && tab.projectPath === selectedProjectPath
            )
          if (existingFileTab) {
            setActiveTabId(existingFileTab.id)
            return current
          }
          setActiveTabId(filesTabId)
          return [...current, { id: filesTabId, tool, title: utilityToolMeta.files.label }]
        })
        return
      }

      const id = toolTabId(tool)
      setTabs((current) => {
        const existing = current.find((tab) => tab.id === id)
        if (existing) {
          setActiveTabId(existing.id)
          return current
        }
        setActiveTabId(id)
        return [...current, { id, tool, title: utilityToolMeta[tool].label }]
      })
    },
    [
      activeFilePath,
      openBrowserTab,
      selectedProjectAvailable,
      selectedProjectPath,
      setActiveTabId,
      setFileProjectPath,
      setTabs,
      setTerminalMounted,
    ]
  )

  useEffect(() => {
    if (!toolOpenRequest || handledToolRequestId === toolOpenRequest.id) return
    const timer = window.setTimeout(() => {
      setHandledToolRequestId(toolOpenRequest.id)
      addTab(toolOpenRequest.tool)
    }, 0)
    return () => window.clearTimeout(timer)
  }, [addTab, handledToolRequestId, setHandledToolRequestId, toolOpenRequest])

  const closeTabs = (tabIds: string[], preferredActiveTabId?: string): void => {
    const closingIds = new Set(tabIds)
    if (closingIds.size === 0) return

    const closingTabs = tabs.filter((tab) => closingIds.has(tab.id))
    const closingFilePaths = new Set(
      closingTabs.map((tab) => tab.filePath).filter((path): path is string => Boolean(path))
    )
    const closingTerminalIds = closingTabs
      .map((tab) => tab.terminalId)
      .filter((terminalId): terminalId is string => Boolean(terminalId))

    setBrowserTabs((current) => current.filter((tab) => !closingIds.has(tab.id)))

    if (closingFilePaths.size > 0) {
      const nextFileTabs = visibleFileTabs.filter((tab) => !closingFilePaths.has(tab.preview.path))
      const preferredTab = tabs.find((tab) => tab.id === preferredActiveTabId)
      const preferredFilePath = preferredTab?.filePath
      const nextActivePath =
        preferredFilePath && !closingFilePaths.has(preferredFilePath)
          ? preferredFilePath
          : preferredTab && !preferredTab.filePath
            ? (nextFileTabs[0]?.preview.path ?? null)
            : activeFilePath && !closingFilePaths.has(activeFilePath)
              ? activeFilePath
              : (nextFileTabs[0]?.preview.path ?? null)

      const nextStoredFileTabs = fileTabsRef.current.filter(
        (tab) => !closingFilePaths.has(tab.preview.path)
      )
      fileTabsRef.current = nextStoredFileTabs
      setFileTabs(nextStoredFileTabs)
      setActiveFilePath(nextActivePath)
      persistFileTabs(
        nextFileTabs.filter((tab) => tab.preview.scope !== "extra-root").map((tab) => tab.preview.path),
        nextActivePath && nextFileTabs.some((tab) => tab.preview.path === nextActivePath && tab.preview.scope !== "extra-root")
          ? nextActivePath
          : null
      )
    }

    setTabs((current) => {
      const nextTabs = current.filter((tab) => !closingIds.has(tab.id))
      if (nextTabs.length === 0) {
        setActiveTabId("")
        setActiveFilePath(null)
        return []
      }

      const visibleNextTabs = nextTabs.filter(
        (tab) => !tab.projectPath || tab.projectPath === selectedProjectPath
      )
      const preferredTab = preferredActiveTabId
        ? visibleNextTabs.find((tab) => tab.id === preferredActiveTabId)
        : undefined
      const fallbackTab = closingIds.has(activeTabId)
        ? (visibleNextTabs[0] ?? nextTabs[0])
        : (visibleNextTabs.find((tab) => tab.id === activeTabId) ??
          visibleNextTabs[0] ??
          nextTabs[0])
      const nextActive = preferredTab ?? fallbackTab
      setActiveTabId(nextActive.id)
      if (nextActive.filePath) setActiveFilePath(nextActive.filePath)
      return nextTabs
    })

    if (closingTerminalIds.length > 0) {
      setTerminalCommands((current) => [
        ...current,
        {
          id: ++terminalCommandSequenceRef.current,
          type: "close",
          terminalIds: closingTerminalIds,
        },
      ])
    }
  }

  const closeTab = (tabId: string): void => {
    closeTabs([tabId])
  }

  const selectTab = (tab: UtilityTab): void => {
    setActiveTabId(tab.id)
    if (tab.filePath) {
      setActiveFilePath(tab.filePath)
      persistFileTabs(
        visibleFileTabs
          .filter((item) => item.preview.scope !== "extra-root")
          .map((item) => item.preview.path),
        visibleFileTabs.some(
          (item) => item.preview.path === tab.filePath && item.preview.scope !== "extra-root"
        )
          ? tab.filePath
          : null
      )
    }
  }

  const startFileTab = (path: string): void => {
    const id = fileTabId(path, selectedProjectPath)
    setTabs((current) =>
      placeFileTab(current, {
        id,
        tool: "files",
        title: fileNameFromPath(path),
        filePath: path,
        fileIcon: getFileIcon(path),
        projectPath: selectedProjectPath,
      })
    )
    setFileProjectPath(selectedProjectPath ?? null)
    setActiveTabId(id)
    setActiveFilePath(path)
  }

  const upsertFileTab = (nextFileTab: FileViewerTab): void => {
    const nextProject = selectedProjectPath ?? null
    const id = fileTabId(nextFileTab.preview.path, selectedProjectPath)
    const nextTabs = mergeFileViewerTabs(fileTabsRef.current, nextFileTab, nextProject)
    fileTabsRef.current = nextTabs
    setFileProjectPath(nextProject)
    setFileTabs(nextTabs)
    setTabs((current) =>
      placeFileTab(current, {
        id,
        tool: "files",
        title: nextFileTab.preview.name,
        filePath: nextFileTab.preview.path,
        fileIcon: getFileIcon(nextFileTab.preview.path),
        fileType: nextFileTab.type,
        projectPath: selectedProjectPath,
      })
    )
    setActiveTabId(id)
    setActiveFilePath(nextFileTab.preview.path)
    persistFileTabs(
      nextTabs
        .filter(
          (tab) =>
            (tab.projectPath ?? null) === nextProject && tab.preview.scope !== "extra-root"
        )
        .map((tab) => tab.preview.path),
      nextFileTab.preview.scope === "extra-root" ? null : nextFileTab.preview.path
    )
  }

  const persistFileTabs = (paths: string[], activePath: string | null): void => {
    if (!selectedProjectPath) return
    setPersistedFileTabs((current) => {
      const nextState = { ...current }
      if (paths.length === 0) {
        delete nextState[scopeId]
      } else {
        nextState[scopeId] = {
          activePath,
          paths: paths.slice(0, 12),
        }
      }
      writePersistedUtilityFileTabs(nextState)
      return nextState
    })
  }

  const updateBrowserTab = (tabId: string, patch: Partial<BrowserToolTab>): void => {
    setBrowserTabs((current) =>
      current.map((tab) => (tab.id === tabId ? { ...tab, ...patch } : tab))
    )
    if (patch.title) {
      setTabs((current) =>
        current.map((tab) => (tab.id === tabId ? { ...tab, title: patch.title ?? tab.title } : tab))
      )
    }
  }

  const upsertTerminalTab = (session: TerminalSessionTabInfo, activate: boolean): void => {
    const id = terminalTabId(session.id)
    setTabs((current) => {
      if (current.some((tab) => tab.id === id)) {
        return current.map((tab) => (tab.id === id ? { ...tab, title: session.title } : tab))
      }
      return [
        ...current.filter((tab) => tab.id !== unavailableTerminalTabId),
        {
          id,
          tool: "terminal",
          title: session.title,
          terminalId: session.id,
          projectPath: selectedProjectPath,
        },
      ]
    })
    if (activate) setActiveTabId(id)
  }

  const removeTerminalTab = (terminalId: string): void => {
    const id = terminalTabId(terminalId)
    setTabs((current) => {
      if (!current.some((tab) => tab.id === id)) return current
      const nextTabs = current.filter((tab) => tab.id !== id)
      if (nextTabs.length === 0) {
        setActiveTabId("")
        return []
      }
      if (activeTabId === id) {
        const previousIndex = current.findIndex((tab) => tab.id === id)
        const nextActive = nextTabs[Math.max(0, previousIndex - 1)] ?? nextTabs[0]
        setActiveTabId(nextActive.id)
        if (nextActive.filePath) setActiveFilePath(nextActive.filePath)
      }
      return nextTabs
    })
  }

  const hydrateTerminalTabs = (sessions: TerminalSessionTabInfo[]): void => {
    setTabs((current) => {
      const others = current.filter(
        (tab) =>
          tab.tool !== "terminal" || (tab.projectPath && tab.projectPath !== selectedProjectPath)
      )
      const terminalTabs = sessions.map((session) => ({
        id: terminalTabId(session.id),
        tool: "terminal" as const,
        title: session.title,
        terminalId: session.id,
        projectPath: selectedProjectPath,
      }))
      return [...others.filter((tab) => tab.id !== unavailableTerminalTabId), ...terminalTabs]
    })
  }

  const handleActiveTerminalChange = (terminalId: string | null): void => {
    if (terminalId) setActiveTabId(terminalTabId(terminalId))
  }

  const closeOtherTabs = (tab: UtilityTab): void => {
    selectTab(tab)
    closeTabs(
      visibleTabs.filter((item) => item.id !== tab.id).map((item) => item.id),
      tab.id
    )
  }

  const closeTabsToRight = (tab: UtilityTab): void => {
    const index = visibleTabs.findIndex((item) => item.id === tab.id)
    if (index < 0) return
    selectTab(tab)
    closeTabs(
      visibleTabs.slice(index + 1).map((item) => item.id),
      tab.id
    )
  }

  return (
    <aside
      aria-hidden={!open}
      className={cn(
        "h-full min-h-0 w-full overflow-hidden bg-conversation transition-opacity duration-150 ease-out",
        open ? "border-l opacity-100" : "pointer-events-none opacity-0"
      )}
    >
      <div className="flex h-full min-w-[320px] flex-col">
        <UtilityPanelTabStrip
          tabs={visibleTabs}
          browserTabs={browserTabs}
          activeTab={activeTab}
          availableTools={availableTools}
          maximized={maximized}
          onAdd={addTab}
          onSelect={selectTab}
          onCloseTab={closeTab}
          onCloseOtherTabs={closeOtherTabs}
          onCloseTabsToRight={closeTabsToRight}
          onToggleMaximized={onToggleMaximized}
          onClosePanel={onClose}
        />

        <div className="relative min-h-0 flex-1 bg-conversation">
          {!activeTab && !pendingTerminal && (
            <EmptyUtilityPanelState availableTools={availableTools} onAdd={addTab} />
          )}
          {browserTabs.map((tab) => (
            <BrowserTool
              key={tab.id}
              tab={tab}
              active={activeTab?.id === tab.id}
              onUpdate={(patch) => updateBrowserTab(tab.id, patch)}
            />
          ))}
          {activeTab?.tool === "files" && (
            <FilesTool
              tabs={visibleFileTabs}
              activePath={visibleActiveFilePath}
              loadingPath={visibleLoadingFilePath}
              onActivePathChange={setActiveFilePath}
              onLoadingPathChange={setLoadingFilePath}
              onOpenFileStart={startFileTab}
              onFileOpened={upsertFileTab}
              restoreActivePath={persistedFileState?.activePath ?? null}
              restorePaths={persistedFileState?.paths ?? []}
              openRequest={fileOpenRequest}
              onOpenHtmlInBrowser={(projectPath, relativePath, name) =>
                openBrowserTab(toLocalFileUrl(projectPath, relativePath), name)
              }
            />
          )}
          {terminalMounted && (
            <TerminalTool
              active={activeTab?.tool === "terminal"}
              activeTerminalId={activeTab?.terminalId ?? null}
              openRequest={terminalOpenRequest}
              command={terminalCommand}
              onSessionUpsert={upsertTerminalTab}
              onSessionRemove={removeTerminalTab}
              onSessionsHydrate={hydrateTerminalTabs}
              onActiveTerminalChange={handleActiveTerminalChange}
              onCommandSettled={(commandId) =>
                setTerminalCommands((current) =>
                  current.filter((command) => command.id !== commandId)
                )
              }
            />
          )}
          {activeTab?.tool === "review" && <ReviewTool openRequest={reviewOpenRequest} />}
          {activeTab?.tool === "side-chat" && (
            <PlaceholderTool
              icon={MessageCirclePlus}
              title="侧边聊天"
              description="后续会承接当前会话上下文，用来和主对话并行沟通。"
            />
          )}
          {tabs.some((tab) => tab.tool === "agents") ? (
            <AgentsTool
              key={activeSessionId ?? "no-session"}
              active={activeTab?.tool === "agents"}
              onOpenFile={onOpenFile}
              canOpenReview={selectedProjectGit}
              onOpenReview={onOpenReview}
              onOpenTerminal={onOpenTerminal}
            />
          ) : null}
        </div>
      </div>
    </aside>
  )
}

function fileTabId(path: string, projectPath?: string): string {
  return `file-tab:${projectPath ?? "no-project"}:${path}`
}

function placeFileTab(current: UtilityTab[], fileTab: UtilityTab): UtilityTab[] {
  const existingIndex = current.findIndex((tab) => tab.id === fileTab.id)
  if (existingIndex >= 0) {
    return current.map((tab, index) =>
      index === existingIndex
        ? {
            ...tab,
            title: fileTab.title,
            fileIcon: fileTab.fileIcon ?? tab.fileIcon,
            fileType: fileTab.fileType ?? tab.fileType,
            filePath: fileTab.filePath,
            projectPath: fileTab.projectPath,
          }
        : tab
    )
  }

  const emptyIndex = current.findIndex((tab) => tab.id === filesTabId)
  if (emptyIndex >= 0) {
    return current.map((tab, index) => (index === emptyIndex ? fileTab : tab))
  }

  return [...current, fileTab]
}

function toolTabId(tool: UtilityTool): string {
  return tool === "files" ? filesTabId : `${tool}-tab`
}

function terminalTabId(terminalId: string): string {
  return `terminal-tab:${terminalId}`
}

function fileNameFromPath(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

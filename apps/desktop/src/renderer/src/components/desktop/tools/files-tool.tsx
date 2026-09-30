import {
  BookOpenText,
  Code2,
  FileCode2,
  FolderOpen,
  PanelRight,
  PanelRightClose,
  RefreshCw,
} from "lucide-react"
import type * as React from "react"
import { useEffect, useMemo, useRef, useState } from "react"
import { Group, Panel, usePanelRef } from "react-resizable-panels"

import { DesktopEmptyState } from "@renderer/components/desktop/desktop-empty-state"
import { FileBreadcrumb } from "@renderer/components/desktop/tools/files/file-breadcrumb"
import { FileSearchControls } from "@renderer/components/desktop/tools/files/file-search-controls"
import { ProjectFileTree } from "@renderer/components/desktop/tools/files/project-file-tree"
import {
  FileViewer,
  type FileSearchMatch,
  type FileViewMode,
  type FileViewerTab,
} from "@renderer/components/desktop/tools/file-viewer"
import { fileViewerTypeForPreview } from "@renderer/components/desktop/tools/file-viewer-model"
import { Button } from "@renderer/components/ui/button"
import { PanelResizeHandle } from "@renderer/components/ui/panel-resize-handle"
import { Spinner } from "@renderer/components/ui/spinner"
import { beginPanelToggleTransition } from "@renderer/components/desktop/layout/main-layout/panel-toggle-transition"
import {
  createPanelWidthStore,
  shouldPersistPanelWidth,
} from "@renderer/components/desktop/layout/panel-width-store"
import {
  selectActiveWorkspaceProject,
  useDesktopSessionStore,
} from "@renderer/stores/desktop-session"
import type {
  WorkspaceFileEntry,
  WorkspaceListFilesResult,
  WorkspaceReadFileResult,
} from "@shared/workspace-types"

type LoadState = "idle" | "loading" | "ready" | "error"

const resizeTargetMinimumSize = { fine: 12, coarse: 28 }
const fileTreeWidthStore = createPanelWidthStore({
  storageKey: "vykor.desktop.file-tree-width-px",
  defaultPx: 300,
  minPx: 220,
  maxPx: 1200,
})

type FilesToolProps = {
  tabs: FileViewerTab[]
  activePath: string | null
  loadingPath: string | null
  onActivePathChange: (path: string | null) => void
  onLoadingPathChange: React.Dispatch<React.SetStateAction<string | null>>
  onOpenFileStart: (path: string) => void
  onFileOpened: (tab: FileViewerTab) => void
  restoreActivePath: string | null
  restorePaths: string[]
  openRequest: { id: number; path: string; line?: number } | null
  onOpenHtmlInBrowser: (projectPath: string, relativePath: string, name: string) => void
}

export function FilesTool({
  tabs,
  activePath,
  loadingPath,
  onActivePathChange,
  onLoadingPathChange,
  onOpenFileStart,
  onFileOpened,
  restoreActivePath,
  restorePaths,
  openRequest,
  onOpenHtmlInBrowser,
}: FilesToolProps): React.JSX.Element {
  const selectedProject = useDesktopSessionStore(selectActiveWorkspaceProject)
  const [loadState, setLoadState] = useState<LoadState>("idle")
  const [error, setError] = useState<string | null>(null)
  const [listing, setListing] = useState<WorkspaceListFilesResult | null>(null)
  const [searchQuery, setSearchQuery] = useState("")
  const [searchIndex, setSearchIndex] = useState(0)
  const [searchOpen, setSearchOpen] = useState(false)
  const [viewModeByPath, setViewModeByPath] = useState<Record<string, FileViewMode>>({})
  const [treeOpen, setTreeOpen] = useState(true)
  const treePanelRef = usePanelRef()
  const fileTreeShellRef = useRef<HTMLElement | null>(null)
  const filesGroupElementRef = useRef<HTMLDivElement | null>(null)
  const treeTransitionCancelRef = useRef<(() => void) | null>(null)
  const [fileTreeDefaultSizePx] = useState(() => fileTreeWidthStore.resolveDefault())
  const restoredProjectRef = useRef<string | null>(null)
  const handledOpenRequestRef = useRef<number | null>(null)
  const resolvedOpenRequestPathRef = useRef<string | null>(null)
  const attemptedPreviewPathRef = useRef<string | null>(null)

  useEffect(
    () => () => {
      treeTransitionCancelRef.current?.()
      treeTransitionCancelRef.current = null
    },
    []
  )

  const fileEntries = useMemo(() => {
    const map = new Map<string, WorkspaceFileEntry>()
    for (const entry of listing?.entries ?? []) map.set(entry.path.replace(/\/$/, ""), entry)
    return map
  }, [listing])
  const treePaths = useMemo(() => listing?.entries.map((entry) => entry.path) ?? [], [listing])
  const activeTab = useMemo(
    () => tabs.find((tab) => tab.preview.path === activePath) ?? null,
    [activePath, tabs]
  )
  const activeIsMarkdown = activeTab?.type === "markdown"
  const activeViewMode: FileViewMode =
    activeIsMarkdown && activePath ? (viewModeByPath[activePath] ?? "preview") : "source"
  const searchMatches = useMemo(
    () => findSearchMatches(activeTab?.preview.content ?? "", searchQuery),
    [activeTab?.preview.content, searchQuery]
  )
  const visibleSearchIndex =
    searchMatches.length === 0 ? -1 : Math.min(searchIndex, searchMatches.length - 1)

  const loadFiles = async (): Promise<void> => {
    if (!selectedProject?.path) {
      setListing(null)
      setLoadState("idle")
      return
    }

    setLoadState("loading")
    setError(null)
    try {
      const result = await window.desktop.workspace.listFiles({ rootPath: selectedProject.path })
      setListing(result)
      setLoadState("ready")
    } catch (loadError) {
      setError(errorMessage(loadError))
      setLoadState("error")
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadFiles()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [selectedProject?.path])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      const wantsFind = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f"
      if (wantsFind) {
        event.preventDefault()
        if (activeTab?.preview.content) setSearchOpen(true)
        return
      }

      if (event.key === "Escape" && searchOpen) {
        event.preventDefault()
        setSearchOpen(false)
      }
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [activeTab?.preview.content, searchOpen])

  const openFile = async (
    path: string,
    options: { requireListedFile?: boolean; fromOpenRequest?: boolean } = {}
  ): Promise<void> => {
    if (!selectedProject?.path) return
    const requireListedFile = options.requireListedFile ?? true
    const normalizedPath = path.replace(/\/$/, "")
    const entry = fileEntries.get(normalizedPath)
    if (requireListedFile && (!entry || entry.type !== "file")) return

    const listed = entry?.type === "file"
    onActivePathChange(normalizedPath)
    if (listed) onOpenFileStart(normalizedPath)
    onLoadingPathChange(normalizedPath)
    setError(null)
    let resultPath: string | undefined
    try {
      const result = await window.desktop.workspace.readFile({
        rootPath: selectedProject.path,
        path: normalizedPath,
      })
      resultPath = result.path
      onActivePathChange(result.path)
      onOpenFileStart(result.path)
      onFileOpened(toFileViewerTab(result))
      if (options.fromOpenRequest) resolvedOpenRequestPathRef.current = result.path
    } catch (readError) {
      setError(errorMessage(readError))
    } finally {
      onLoadingPathChange((current) =>
        current === normalizedPath || current === resultPath ? null : current
      )
    }
  }

  useEffect(() => {
    if (!activePath || loadState !== "ready") return
    if (tabs.some((tab) => tab.preview.path === activePath)) {
      if (attemptedPreviewPathRef.current === activePath) attemptedPreviewPathRef.current = null
      return
    }
    if (loadingPath === activePath) return
    if (attemptedPreviewPathRef.current === activePath) return
    attemptedPreviewPathRef.current = activePath
    const timer = window.setTimeout(() => {
      void openFile(activePath, { requireListedFile: false })
    }, 0)
    return () => window.clearTimeout(timer)
  }, [activePath, loadState, loadingPath, tabs])

  useEffect(() => {
    if (!openRequest || loadState !== "ready" || handledOpenRequestRef.current === openRequest.id)
      return
    handledOpenRequestRef.current = openRequest.id
    resolvedOpenRequestPathRef.current = null
    const requestedPath = openRequest.path.trim()
    const timer = window.setTimeout(() => {
      if (requestedPath) void openFile(requestedPath, { requireListedFile: false, fromOpenRequest: true })
    }, 0)
    return () => window.clearTimeout(timer)
  }, [fileEntries, loadState, openRequest, selectedProject?.path])

  async function restoreOpenFiles(): Promise<void> {
    if (!selectedProject?.path) return
    const existingPaths = restorePaths
      .map((path) => path.replace(/\/$/, ""))
      .filter((path) => fileEntries.get(path)?.type === "file")
      .slice(0, 12)
    if (existingPaths.length === 0) return

    const activeRestorePath =
      restoreActivePath && existingPaths.includes(restoreActivePath)
        ? restoreActivePath
        : existingPaths[0]
    const orderedPaths = [
      ...existingPaths.filter((path) => path !== activeRestorePath),
      activeRestorePath,
    ]

    for (const path of orderedPaths) {
      onOpenFileStart(path)
      onLoadingPathChange(path)
      try {
        const result = await window.desktop.workspace.readFile({
          rootPath: selectedProject.path,
          path,
        })
        onFileOpened(toFileViewerTab(result))
      } catch (restoreError) {
        setError(errorMessage(restoreError))
      } finally {
        onLoadingPathChange((current) => (current === path ? null : current))
      }
    }
  }

  useEffect(() => {
    if (
      loadState !== "ready" ||
      !selectedProject?.path ||
      restoredProjectRef.current === selectedProject.path ||
      tabs.length > 0 ||
      restorePaths.length === 0
    ) {
      return
    }

    const timer = window.setTimeout(() => {
      restoredProjectRef.current = selectedProject.path
      void restoreOpenFiles()
    }, 0)

    return () => window.clearTimeout(timer)
  }, [loadState, selectedProject?.path, restoreActivePath, restorePaths, tabs.length])

  const handleTreeLayoutChanged = (
    _layout: Record<string, number>,
    meta: { isUserInteraction: boolean }
  ): void => {
    const size = treePanelRef.current?.getSize()
    if (!size || !shouldPersistPanelWidth(meta, size.inPixels)) return
    fileTreeWidthStore.persist(size.inPixels)
  }

  const toggleTree = (): void => {
    const panel = treePanelRef.current
    if (!panel) {
      setTreeOpen((current) => !current)
      return
    }

    treeTransitionCancelRef.current?.()
    treeTransitionCancelRef.current = beginPanelToggleTransition(filesGroupElementRef.current)
    if (panel.isCollapsed()) {
      panel.expand()
    } else {
      panel.collapse()
    }
  }

  const setActiveViewMode = (mode: FileViewMode): void => {
    if (!activePath) return
    setViewModeByPath((current) => ({ ...current, [activePath]: mode }))
  }

  const moveSearchMatch = (direction: -1 | 1): void => {
    if (searchMatches.length === 0) return
    if (activeIsMarkdown && activeViewMode === "preview") setActiveViewMode("source")
    setSearchIndex((current) => {
      const safeCurrent = Math.max(0, Math.min(current, searchMatches.length - 1))
      return (safeCurrent + direction + searchMatches.length) % searchMatches.length
    })
  }

  if (!selectedProject) {
    return (
      <DesktopEmptyState
        icon={FolderOpen}
        size="sm"
        title="打开文件"
        description="从工作区目录树中选择文件"
      />
    )
  }

  return (
    <section
      ref={fileTreeShellRef}
      className="flex h-full min-h-0 flex-col"
      style={
        {
          "--file-tree-content-width": `${fileTreeDefaultSizePx}px`,
        } as React.CSSProperties
      }
    >
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border/45 px-2.5">
        <FileBreadcrumb
          projectName={selectedProject.name}
          path={activeTab?.preview.relativePath ?? activePath ?? "/"}
          scope={activeTab?.preview.scope}
          rootLabel={activeTab?.preview.rootLabel}
        />
        {activeIsMarkdown && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={activeViewMode === "preview" ? "查看 Markdown 源码" : "预览 Markdown"}
            title={activeViewMode === "preview" ? "查看 Markdown 源码" : "预览 Markdown"}
            onClick={() => setActiveViewMode(activeViewMode === "preview" ? "source" : "preview")}
            aria-pressed={activeViewMode === "preview"}
            className="text-muted-foreground aria-pressed:bg-muted aria-pressed:text-foreground"
          >
            {activeViewMode === "preview" ? <Code2 /> : <BookOpenText />}
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={treeOpen ? "收起文件树" : "展开文件树"}
          title={treeOpen ? "收起文件树" : "展开文件树"}
          onClick={toggleTree}
          className="text-muted-foreground"
        >
          {treeOpen ? <PanelRightClose /> : <PanelRight />}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="刷新文件树"
          title="刷新文件树"
          onClick={() => void loadFiles()}
          className="text-muted-foreground"
        >
          <RefreshCw />
        </Button>
      </div>

      {loadState === "loading" && (
        <div className="text-ui-small flex flex-1 items-center justify-center gap-2 text-ui-muted">
          <Spinner />
          正在读取项目文件...
        </div>
      )}

      {loadState === "error" && (
        <DesktopEmptyState
          icon={FileCode2}
          size="sm"
          title="无法读取项目"
          description={error ?? "请稍后重试。"}
        />
      )}

      {loadState === "ready" && listing && (
        <Group
          id="desktop-files-tool"
          orientation="horizontal"
          className="min-h-0 flex-1"
          elementRef={filesGroupElementRef}
          resizeTargetMinimumSize={resizeTargetMinimumSize}
          onLayoutChanged={handleTreeLayoutChanged}
        >
          <Panel
            id="file-preview"
            minSize={280}
            className="relative min-h-0 min-w-0 overflow-hidden"
          >
            {searchOpen && (
              <div className="absolute top-3 right-3 z-40">
                <FileSearchControls
                  query={searchQuery}
                  matchCount={searchMatches.length}
                  matchIndex={visibleSearchIndex}
                  disabled={!activeTab?.preview.content}
                  onQueryChange={(query) => {
                    setSearchQuery(query)
                    setSearchIndex(0)
                  }}
                  onPrevious={() => moveSearchMatch(-1)}
                  onNext={() => moveSearchMatch(1)}
                  onClose={() => setSearchOpen(false)}
                />
              </div>
            )}
            <FileViewer
              tabs={tabs}
              activePath={activePath}
              loadingPath={loadingPath}
              viewMode={activeViewMode}
              searchQuery={searchQuery}
              searchMatchIndex={visibleSearchIndex}
              searchMatches={searchMatches}
              targetLine={
                openRequest && resolvedOpenRequestPathRef.current === activePath
                  ? openRequest.line
                  : undefined
              }
              onOpenHtmlInBrowser={onOpenHtmlInBrowser}
            />
          </Panel>

          {treeOpen ? <PanelResizeHandle label="调整文件树宽度" /> : null}

          <Panel
            id="file-tree"
            panelRef={treePanelRef}
            defaultSize={fileTreeDefaultSizePx}
            minSize={fileTreeWidthStore.minPx}
            maxSize="45%"
            collapsedSize={0}
            collapsible
            groupResizeBehavior="preserve-pixel-size"
            className="min-h-0 overflow-hidden border-l border-border/45"
            style={{ overflow: "hidden" }}
            onResize={(size) => {
              if (
                size.inPixels > 1 &&
                !filesGroupElementRef.current?.hasAttribute("data-panel-animating")
              ) {
                fileTreeShellRef.current?.style.setProperty(
                  "--file-tree-content-width",
                  `${size.inPixels}px`
                )
              }
              const nextOpen = size.inPixels > 1
              setTreeOpen((current) => (current === nextOpen ? current : nextOpen))
            }}
          >
            <div
              className="flex h-full min-h-0 flex-col"
              style={{ width: "var(--file-tree-content-width)" }}
            >
              <ProjectFileTree
                rootPath={selectedProject.path}
                paths={treePaths}
                selectedPath={activeTab?.preview.scope === "extra-root" ? null : activePath}
                onSelect={(path) => void openFile(path)}
                onOpenHtmlInBrowser={onOpenHtmlInBrowser}
                onActionError={(actionError) => setError(errorMessage(actionError))}
              />
            </div>
          </Panel>
        </Group>
      )}
    </section>
  )
}

function errorMessage(error: unknown): string {
  if (error instanceof Error)
    return error.message.replace(/^Error invoking remote method '[^']+': /, "")
  return String(error)
}

function toFileViewerTab(preview: WorkspaceReadFileResult): FileViewerTab {
  return {
    preview,
    type: fileViewerTypeForPreview(preview),
  }
}

function findSearchMatches(content: string, query: string): FileSearchMatch[] {
  const needle = query.trim()
  if (!content || !needle) return []

  const lowerContent = content.toLocaleLowerCase()
  const lowerNeedle = needle.toLocaleLowerCase()
  const matches: FileSearchMatch[] = []
  let line = 0
  let lineStart = 0
  let index = lowerContent.indexOf(lowerNeedle)

  while (index !== -1 && matches.length < 1000) {
    while (lineStart <= index) {
      const nextNewline = content.indexOf("\n", lineStart)
      if (nextNewline === -1 || nextNewline >= index) break
      line += 1
      lineStart = nextNewline + 1
    }

    matches.push({ index, line, column: index - lineStart })
    index = lowerContent.indexOf(lowerNeedle, index + lowerNeedle.length)
  }

  return matches
}

import { FileCode2, FolderOpen } from "lucide-react"
import type * as React from "react"
import { useEffect, useMemo, useRef, useState } from "react"
import { Group, Panel, usePanelRef } from "react-resizable-panels"

import { DesktopEmptyState } from "@renderer/components/desktop/shared/desktop-empty-state"
import { FileViewerToolbar } from "./file-viewer-toolbar"
import { FileSearchControls } from "@renderer/components/desktop/tools/files/file-search-controls"
import { ProjectFileTree } from "@renderer/components/desktop/tools/files/project-file-tree"
import {
  FileViewer,
  type FileSearchMatch,
  type FileViewMode,
  type FileViewerTab,
} from "@renderer/components/desktop/tools/files/file-viewer"
import { fileViewerTypeForPreview, isWebDocumentPath } from "@renderer/components/desktop/tools/files/file-viewer-model"
import { useCodePreviewDrafts } from "../editor/code-preview-drafts"
import { PanelResizeHandle } from "@renderer/components/ui/panel-resize-handle"
import { Spinner } from "@renderer/components/ui/spinner"
import { beginPanelToggleTransition } from "@renderer/components/desktop/layout/main-layout/panel-toggle-transition"
import {
  createPanelWidthStore,
  shouldPersistPanelWidth,
} from "@renderer/components/desktop/layout/shared/panel-width-store"
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
  scopeId: string
  visible: boolean
  tabs: FileViewerTab[]
  activePath: string | null
  loadingPath: string | null
  onActivePathChange: (path: string | null) => void
  onLoadingPathChange: React.Dispatch<React.SetStateAction<string | null>>
  onOpenFileStart: (path: string) => void
  onFileOpened: (tab: FileViewerTab) => void
  onFileUpdated?: (preview: WorkspaceReadFileResult) => void
  restoreActivePath: string | null
  restorePaths: string[]
  openRequest: { id: number; path: string; line?: number } | null
  onOpenMissingWebDocument: (rootPath: string, path: string) => void
}

export function FilesTool({
  scopeId,
  visible,
  tabs,
  activePath,
  loadingPath,
  onActivePathChange,
  onLoadingPathChange,
  onOpenFileStart,
  onFileOpened,
  onFileUpdated,
  restoreActivePath,
  restorePaths,
  openRequest,
  onOpenMissingWebDocument,
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
  const [resolvedOpenRequestPath, setResolvedOpenRequestPath] = useState<string | null>(null)
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
  const activePreviewFormat =
    activeTab?.type === "html"
      ? "HTML"
      : activeTab?.type === "svg"
        ? "SVG"
        : activeTab?.type === "markdown"
          ? "Markdown"
          : undefined
  const activeCanPreview = activePreviewFormat !== undefined
  const codeEditing = useCodePreviewDrafts(
    (state) =>
      state.drafts[JSON.stringify([scopeId, activeTab?.projectPath, activeTab?.preview.path])]
        ?.editing ?? false
  )
  const searchableContent = useCodePreviewDrafts((state) => {
    const draft =
      state.drafts[JSON.stringify([scopeId, activeTab?.projectPath, activeTab?.preview.path])]
    return draft && !draft.editing ? draft.content : (activeTab?.preview.content ?? "")
  })
  const activeViewMode: FileViewMode =
    activeCanPreview && activePath ? (viewModeByPath[activePath] ?? "preview") : "source"
  const searchMatches = useMemo(
    () => findSearchMatches(searchableContent, searchQuery),
    [searchableContent, searchQuery]
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
      if (event.defaultPrevented || (codeEditing && activeViewMode === "source")) return
      const wantsFind = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f"
      if (wantsFind) {
        event.preventDefault()
        if (typeof activeTab?.preview.content === "string") {
          setSearchOpen(true)
          if (activeCanPreview && activePath)
            setViewModeByPath((current) => ({ ...current, [activePath]: "source" }))
        }
        return
      }

      if (event.key === "Escape" && searchOpen) {
        event.preventDefault()
        setSearchOpen(false)
      }
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [
    activeTab?.preview.content,
    searchOpen,
    codeEditing,
    activeViewMode,
    activeCanPreview,
    activePath,
  ])

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
      const fileTab = toFileViewerTab(result)
      onFileOpened(fileTab)
      if (options.fromOpenRequest) {
        setResolvedOpenRequestPath(result.path)
        if (fileTab.type === "html" || fileTab.type === "svg")
          setViewModeByPath((current) => ({ ...current, [result.path]: "preview" }))
      }
    } catch (readError) {
      const message = errorMessage(readError)
      if (options.fromOpenRequest && isWebDocumentPath(normalizedPath) && (message.endsWith("文件不存在。") || /(?:^|[\s:])ENOENT(?=[:,\s]|$)/.test(message))) {
        onOpenMissingWebDocument(selectedProject.path, normalizedPath)
      } else {
        setError(message)
      }
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
    const requestedPath = openRequest.path.trim()
    const timer = window.setTimeout(() => {
      handledOpenRequestRef.current = openRequest.id
      setResolvedOpenRequestPath(null)
      if (requestedPath)
        void openFile(requestedPath, { requireListedFile: false, fromOpenRequest: true })
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
    if (activeCanPreview && activeViewMode === "preview") setActiveViewMode("source")
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
      <FileViewerToolbar
        projectName={selectedProject.name}
        path={activePath ?? "/"}
        preview={activeTab?.preview}
        format={activePreviewFormat}
        viewMode={activeViewMode}
        treeOpen={treeOpen}
        onViewModeChange={setActiveViewMode}
        onToggleTree={toggleTree}
        onRefresh={() => void loadFiles()}
      />

      {loadState === "ready" && error && (
        <p role="alert" className="border-b border-border/45 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

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
            {searchOpen && !(codeEditing && activeViewMode === "source") && (
              <div className="absolute top-3 right-3 left-3 z-40 ml-auto max-w-sm">
                <FileSearchControls
                  query={searchQuery}
                  matchCount={searchMatches.length}
                  matchIndex={visibleSearchIndex}
                  disabled={typeof activeTab?.preview.content !== "string"}
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
              scopeId={scopeId}
              tabs={tabs}
              activePath={activePath}
              loadingPath={loadingPath}
              viewMode={activeViewMode}
              visible={visible}
              searchQuery={searchQuery}
              searchMatchIndex={visibleSearchIndex}
              searchMatches={searchMatches}
              targetLine={
                openRequest && resolvedOpenRequestPath === activePath ? openRequest.line : undefined
              }
              onFileUpdated={onFileUpdated}
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
                onRenderFile={(path) => {
                  setViewModeByPath((current) => ({ ...current, [path]: "preview" }))
                  void openFile(path)
                }}
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

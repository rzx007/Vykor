import {
  BookOpenText,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Code2,
  Copy,
  FileCode2,
  FilePlus2,
  FolderOpen,
  Globe2,
  PanelRight,
  PanelRightClose,
  RefreshCw,
  Search,
  X,
  type LucideIcon,
} from "lucide-react"
import type * as React from "react"
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { createPortal } from "react-dom"
import {
  prepareFileTreeInput,
  type ContextMenuAnchorRect,
  type ContextMenuItem,
} from "@pierre/trees"

import { FileTree, useFileTree, useFileTreeSearch } from "@pierre/trees/react"
import { Group, Panel, usePanelRef } from "react-resizable-panels"

import { OpenWithSubmenu } from "@renderer/components/desktop/open-with"
import { DesktopEmptyState } from "@renderer/components/desktop/desktop-empty-state"
import {
  FileViewer,
  type FileSearchMatch,
  type FileViewMode,
  type FileViewerTab,
} from "@renderer/components/desktop/tools/file-viewer"
import {
  fileViewerTypeForPreview,
  isHtmlPath,
} from "@renderer/components/desktop/tools/file-viewer-model"
import { Button } from "@renderer/components/ui/button"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@renderer/components/ui/input-group"
import { PanelResizeHandle } from "@renderer/components/ui/panel-resize-handle"
import { Spinner } from "@renderer/components/ui/spinner"
import {
  selectActiveWorkspaceProject,
  useDesktopSessionStore,
} from "@renderer/stores/desktop-session-store"
import type {
  WorkspaceFileEntry,
  WorkspaceListFilesResult,
  WorkspaceReadFileResult,
} from "@shared/workspace-types"

type LoadState = "idle" | "loading" | "ready" | "error"
type FileTreeAction =
  "reveal" | "open-html-in-browser" | "copy-relative" | "copy-absolute" | "add-to-chat"

const fileTreeDefaultWidth = 300
const fileTreeMinimumWidth = 220
const resizeTargetMinimumSize = { fine: 12, coarse: 28 }

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
  const restoredProjectRef = useRef<string | null>(null)
  const handledOpenRequestRef = useRef<number | null>(null)
  const resolvedOpenRequestPathRef = useRef<string | null>(null)
  const attemptedPreviewPathRef = useRef<string | null>(null)

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

  const toggleTree = (): void => {
    const panel = treePanelRef.current
    if (!panel) {
      setTreeOpen((current) => !current)
      return
    }

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
    <section className="flex h-full min-h-0 flex-col">
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
          resizeTargetMinimumSize={resizeTargetMinimumSize}
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
            defaultSize={fileTreeDefaultWidth}
            minSize={fileTreeMinimumWidth}
            maxSize="45%"
            collapsedSize={0}
            collapsible
            groupResizeBehavior="preserve-pixel-size"
            className="min-h-0 overflow-hidden border-l border-border/45"
            onResize={(size) => {
              const nextOpen = size.inPixels > 1
              setTreeOpen((current) => (current === nextOpen ? current : nextOpen))
            }}
          >
            <div className="flex h-full min-h-0 flex-col">
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

function FileBreadcrumb({
  projectName,
  path,
  scope,
  rootLabel,
}: {
  projectName: string
  path: string
  scope?: WorkspaceReadFileResult["scope"]
  rootLabel?: string
}): React.JSX.Element {
  const rootName = scope === "extra-root" && rootLabel ? rootLabel : projectName
  const normalizedPath = path.trim() || "/"
  const segments = normalizedPath === "/" ? [] : normalizedPath.split("/").filter(Boolean)

  return (
    <nav
      aria-label="文件路径"
      className="text-ui-small flex min-w-0 flex-1 items-center gap-1 overflow-hidden text-ui-muted"
    >
      <span className="max-w-40 shrink-0 truncate text-ui-foreground" title={rootName}>
        {rootName}
      </span>
      {segments.length === 0 ? (
        <>
          <ChevronRight className="size-3.5 shrink-0 text-ui-muted/70" strokeWidth={1.8} />
          <span className="font-medium text-ui-foreground">/</span>
        </>
      ) : (
        segments.map((segment, index) => {
          const last = index === segments.length - 1
          return (
            <span key={`${segment}-${index}`} className="flex min-w-0 items-center gap-1">
              <ChevronRight className="size-3.5 shrink-0 text-ui-muted/70" strokeWidth={1.8} />
              <span
                className={last ? "truncate font-semibold text-ui-foreground" : "truncate"}
                title={segment}
              >
                {segment}
              </span>
            </span>
          )
        })
      )}
    </nav>
  )
}

function ProjectFileTree({
  rootPath,
  paths,
  selectedPath,
  onSelect,
  onOpenHtmlInBrowser,
  onActionError,
}: {
  rootPath: string
  paths: string[]
  selectedPath: string | null
  onSelect: (path: string) => void
  onOpenHtmlInBrowser: (projectPath: string, relativePath: string, name: string) => void
  onActionError: (error: unknown) => void
}): React.JSX.Element {
  const preparedInput = useMemo(
    () => prepareFileTreeInput(paths, { flattenEmptyDirectories: true }),
    [paths]
  )
  const { model } = useFileTree({
    density: "compact",
    flattenEmptyDirectories: true,
    fileTreeSearchMode: "hide-non-matches",
    initialExpansion: "closed",
    initialVisibleRowCount: 36,
    initialSelectedPaths: selectedPath ? [selectedPath] : [],
    overscan: 18,
    preparedInput,
    search: true,
    stickyFolders: true,
    onSelectionChange: (selectedPaths) => {
      const nextPath = selectedPaths[0]
      if (nextPath) onSelect(nextPath)
    },
    unsafeCSS: `
      :host {
        --trees-bg-override: var(--panel);
        --trees-bg-muted-override: var(--muted);
        --trees-border-color-override: color-mix(in oklab, var(--border) 62%, transparent);
        --trees-fg-override: var(--ui-foreground);
        --trees-fg-muted-override: var(--ui-muted);
        --trees-focus-ring-color-override: var(--ring);
        --trees-indent-guide-bg-override: color-mix(in oklab, var(--ui-muted) 22%, transparent);
        --trees-input-bg-override: color-mix(in oklab, var(--panel) 96%, var(--foreground) 4%);
        --trees-padding-inline-override: 8px;
        --trees-scrollbar-gutter-override: 7px;
        --trees-scrollbar-thumb-override: color-mix(in oklab, var(--ui-muted) 34%, transparent);
        --trees-search-fg-override: var(--ui-foreground);
        --trees-selected-bg-override: var(--sidebar-selected);
        --trees-selected-fg-override: var(--foreground);
        font-family: var(--font-sans);
        --trees-font-family-override: var(--font-sans);
        --trees-font-size-override: var(--ui-font-size-xs);
        --trees-font-weight-regular-override: 450;
        --trees-item-padding-x-override: 7px;
      }

      [data-type="item"] {
        transition: background-color 120ms ease, color 120ms ease;
      }

      [data-type="item"][data-item-selected="true"] {
        font-weight: 520;
      }

      [data-file-tree-search-container] {
        display: none;
      }
    `,
  })
  const search = useFileTreeSearch(model)

  useEffect(() => {
    model.resetPaths({ preparedInput, initialExpandedPaths: [] })
  }, [model, preparedInput])

  const handleContextAction = async (
    action: FileTreeAction,
    item: ContextMenuItem
  ): Promise<void> => {
    try {
      if (action === "reveal") {
        await window.desktop.workspace.revealPath({ rootPath, path: item.path })
        return
      }

      if (action === "open-html-in-browser") {
        if (item.kind === "file" && isHtmlPath(item.path)) {
          onOpenHtmlInBrowser(rootPath, item.path, item.name)
        }
        return
      }

      if (action === "copy-relative") {
        await window.desktop.workspace.copyPath({ rootPath, path: item.path })
        return
      }

      if (action === "copy-absolute") {
        await window.desktop.workspace.copyPath({ rootPath, path: item.path, absolute: true })
        return
      }

      window.dispatchEvent(
        new CustomEvent("desktop:add-to-composer", {
          detail: { text: formatFileMention(item) },
        })
      )
    } catch (error) {
      onActionError(error)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-border/45 px-2 py-2">
        <InputGroup className="h-8 bg-transparent shadow-none has-[[data-slot=input-group-control]:focus-visible]:ring-0">
          <InputGroupAddon align="inline-start">
            <Search />
          </InputGroupAddon>
          <InputGroupInput
            value={search.value}
            placeholder="搜索文件"
            onChange={(event) => {
              const next = event.target.value
              search.setValue(next.length > 0 ? next : null)
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape" && search.value) {
                event.preventDefault()
                search.close()
              }
            }}
          />
        </InputGroup>
      </div>
      <div className="min-h-0 flex-1">
        <FileTree
          model={model}
          renderContextMenu={(item, context) => (
            <FileTreeContextMenu
              item={item}
              rootPath={rootPath}
              anchorRect={context.anchorRect}
              onClose={context.close}
              onActionError={onActionError}
              onAction={(action) => {
                context.close()
                void handleContextAction(action, item)
              }}
            />
          )}
          style={{ height: "100%" }}
        />
      </div>
    </div>
  )
}

function FileTreeContextMenu({
  item,
  rootPath,
  anchorRect,
  onAction,
  onClose,
  onActionError,
}: {
  item: ContextMenuItem
  rootPath: string
  anchorRect: ContextMenuAnchorRect
  onAction: (action: FileTreeAction) => void
  onClose: () => void
  onActionError: (error: unknown) => void
}): React.JSX.Element {
  const menuRef = useRef<HTMLDivElement | null>(null)
  const [position, setPosition] = useState(() => clampFileTreeMenuPosition(anchorRect, 256, 320))

  useLayoutEffect(() => {
    const place = (): void => {
      const menu = menuRef.current
      const width = menu?.offsetWidth || 256
      const height = menu?.offsetHeight || 280
      setPosition(clampFileTreeMenuPosition(anchorRect, width, height))
    }

    place()
    window.addEventListener("resize", place)
    window.addEventListener("scroll", place, true)
    return () => {
      window.removeEventListener("resize", place)
      window.removeEventListener("scroll", place, true)
    }
  }, [anchorRect])

  return createPortal(
    <div
      ref={menuRef}
      data-file-tree-context-menu-root="true"
      style={{ top: position.top, left: position.left }}
      onMouseDown={(event) => {
        event.stopPropagation()
      }}
      className="text-ui-small fixed z-50 w-64 rounded-xl border border-border/55 bg-popover p-1.5 text-popover-foreground shadow-xl shadow-black/12 dark:border-white/8 dark:shadow-black/40"
    >
      <FileTreeMenuButton icon={FolderOpen} onClick={() => onAction("reveal")}>
        在 File Explorer 中打开
      </FileTreeMenuButton>

      {item.kind === "file" && isHtmlPath(item.path) ? (
        <FileTreeMenuButton icon={Globe2} onClick={() => onAction("open-html-in-browser")}>
          在内置浏览器打开
        </FileTreeMenuButton>
      ) : null}

      <OpenWithSubmenu
        path={item.path}
        rootPath={rootPath}
        onPicked={onClose}
        onError={onActionError}
      />

      <div className="my-1 h-px bg-border/45" />

      <FileTreeMenuButton icon={Copy} onClick={() => onAction("copy-relative")}>
        复制相对路径
      </FileTreeMenuButton>
      <FileTreeMenuButton icon={Copy} onClick={() => onAction("copy-absolute")}>
        复制完整路径
      </FileTreeMenuButton>
      <FileTreeMenuButton icon={FilePlus2} onClick={() => onAction("add-to-chat")}>
        添加到聊天
      </FileTreeMenuButton>

      <div className="text-ui-caption mt-1 border-t border-border/45 px-2.5 pt-2 pb-1 text-ui-muted">
        {item.kind === "directory" ? "文件夹" : "文件"} · {item.name}
      </div>
    </div>,
    document.body
  )
}

function clampFileTreeMenuPosition(
  anchor: ContextMenuAnchorRect,
  width: number,
  height: number
): { top: number; left: number } {
  const margin = 8
  const openRight = anchor.right + width + margin <= window.innerWidth
  const left = openRight
    ? Math.min(anchor.right, window.innerWidth - width - margin)
    : Math.max(margin, anchor.left - width)
  return {
    left: Math.max(margin, Math.min(left, window.innerWidth - width - margin)),
    top: Math.min(
      Math.max(margin, anchor.top),
      Math.max(margin, window.innerHeight - height - margin)
    ),
  }
}

function FileTreeMenuButton({
  icon: Icon,
  disabled,
  onClick,
  children,
}: {
  icon: LucideIcon
  disabled?: boolean
  onClick?: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <Button
      type="button"
      variant="ghost"
      disabled={disabled}
      onClick={onClick}
      className="h-9 w-full justify-start px-2.5 font-normal"
    >
      <Icon className="text-muted-foreground" strokeWidth={1.8} />
      <span className="min-w-0 flex-1 truncate text-start">{children}</span>
    </Button>
  )
}

function formatFileMention(item: ContextMenuItem): string {
  const path = item.kind === "directory" ? item.path.replace(/\/$/, "") : item.path
  return item.kind === "directory" ? `@${path}/` : `@${path}`
}

function FileSearchControls({
  query,
  matchCount,
  matchIndex,
  disabled,
  onQueryChange,
  onPrevious,
  onNext,
  onClose,
}: {
  query: string
  matchCount: number
  matchIndex: number
  disabled: boolean
  onQueryChange: (query: string) => void
  onPrevious: () => void
  onNext: () => void
  onClose: () => void
}): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const hasQuery = query.trim().length > 0
  const canNavigate = hasQuery && matchCount > 0

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  return (
    <div className="flex h-12 min-w-0 shrink-0 items-center rounded-xl border border-border/70 bg-popover px-2 text-ui-muted shadow-lg shadow-black/12 dark:border-white/12 dark:shadow-black/35">
      <Search className="ml-0.5 size-4 shrink-0" strokeWidth={1.8} />
      <input
        ref={inputRef}
        value={query}
        disabled={disabled}
        placeholder="搜索当前文件"
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault()
            if (!canNavigate) return
            if (event.shiftKey) {
              onPrevious()
            } else {
              onNext()
            }
            return
          }

          if (event.key === "Escape") {
            event.preventDefault()
            onClose()
          }
        }}
        className="text-ui-small h-full w-52 min-w-0 bg-transparent px-2 text-ui-foreground placeholder:text-ui-muted focus:outline-none disabled:cursor-not-allowed disabled:opacity-45"
      />
      {hasQuery && (
        <span className="shrink-0 px-2 text-xs text-ui-muted tabular-nums">
          {matchCount > 0 ? `${matchIndex + 1}/${matchCount}` : "No results"}
        </span>
      )}
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="上一个搜索结果"
        title="上一个搜索结果"
        disabled={!canNavigate}
        onClick={onPrevious}
      >
        <ChevronUp />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="下一个搜索结果"
        title="下一个搜索结果"
        disabled={!canNavigate}
        onClick={onNext}
      >
        <ChevronDown />
      </Button>
      <Button
        type="button"
        size="icon-sm"
        aria-label="关闭搜索"
        title="关闭搜索"
        onClick={onClose}
        className="-mt-9 -mr-4 ml-1 rounded-full bg-muted-foreground text-popover hover:bg-foreground"
      >
        <X />
      </Button>
    </div>
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

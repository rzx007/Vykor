import { Copy, FilePlus2, FolderOpen, Globe2, Search, type LucideIcon } from "lucide-react"
import type * as React from "react"
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { prepareFileTreeInput, type ContextMenuAnchorRect, type ContextMenuItem } from "@pierre/trees"
import { FileTree, useFileTree, useFileTreeSearch } from "@pierre/trees/react"
import { OpenWithSubmenu } from "@renderer/components/desktop/open-with"
import { isHtmlPath } from "@renderer/components/desktop/tools/file-viewer-model"
import { Button } from "@renderer/components/ui/button"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@renderer/components/ui/input-group"

type FileTreeAction = "reveal" | "open-html-in-browser" | "copy-relative" | "copy-absolute" | "add-to-chat"

export function ProjectFileTree({
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

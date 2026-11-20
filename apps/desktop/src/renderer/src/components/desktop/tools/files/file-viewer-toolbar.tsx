import { BookOpenText, Code2, PanelRight, PanelRightClose, RefreshCw } from "lucide-react"
import { Button } from "@renderer/components/ui/button"
import { ButtonGroup } from "@renderer/components/ui/button-group"
import type { WorkspaceReadFileResult } from "@shared/workspace-types"
import { FileBreadcrumb } from "./file-breadcrumb"
import type { FileViewMode } from "./file-viewer"

export function FileViewerToolbar({
  projectName,
  path,
  preview,
  format,
  viewMode,
  treeOpen,
  onViewModeChange,
  onToggleTree,
  onRefresh,
}: {
  projectName: string
  path: string
  preview?: WorkspaceReadFileResult
  format?: "Markdown"
  viewMode: FileViewMode
  treeOpen: boolean
  onViewModeChange: (mode: FileViewMode) => void
  onToggleTree: () => void
  onRefresh: () => void
}) {
  return (
    <div className="flex min-w-0 shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-border/45 px-2.5 py-1.5">
      <div className="min-w-0 flex-[1_1_12rem] overflow-hidden">
        <FileBreadcrumb
          projectName={projectName}
          path={preview?.relativePath ?? path}
          scope={preview?.scope}
          rootLabel={preview?.rootLabel}
        />
      </div>
      <div className="ml-auto flex max-w-full flex-wrap items-center justify-end gap-2">
        <ButtonGroup variant="toolbar" aria-label="文件操作">
          {format && (
            <Button
              type="button"
              variant="ghost"
              shape="circle"
              size="icon-sm"
              aria-label={viewMode === "preview" ? `查看 ${format} 源码` : `渲染 ${format}`}
              title={viewMode === "preview" ? `查看 ${format} 源码` : `渲染 ${format}`}
              aria-pressed={viewMode === "source"}
              onClick={() => onViewModeChange(viewMode === "preview" ? "source" : "preview")}
            >
              {viewMode === "preview" ? <Code2 /> : <BookOpenText />}
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            shape="circle"
            size="icon-sm"
            aria-label={treeOpen ? "收起文件树" : "展开文件树"}
            title={treeOpen ? "收起文件树" : "展开文件树"}
            onClick={onToggleTree}
          >
            {treeOpen ? <PanelRightClose /> : <PanelRight />}
          </Button>
          <Button
            type="button"
            variant="ghost"
            shape="circle"
            size="icon-sm"
            aria-label="刷新文件树"
            title="刷新文件树"
            onClick={onRefresh}
          >
            <RefreshCw />
          </Button>
        </ButtonGroup>
      </div>
    </div>
  )
}

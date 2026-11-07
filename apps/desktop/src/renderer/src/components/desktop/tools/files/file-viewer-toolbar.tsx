import { Eye, Code2, PanelRight, PanelRightClose, RefreshCw } from "lucide-react"
import { Button } from "@renderer/components/ui/button"
import { ButtonGroup } from "@renderer/components/ui/button-group"
import { ToggleGroup, ToggleGroupItem } from "@renderer/components/ui/toggle-group"
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
  format?: "HTML" | "SVG" | "Markdown"
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
        {format && (
          <ToggleGroup
            aria-label={`${format} 显示模式`}
            value={[viewMode]}
            onValueChange={(values) => {
              const mode = values[0]
              if (mode === "preview" || mode === "source") onViewModeChange(mode)
            }}
            size="sm"
            spacing={0.5}
            className="shrink-0 rounded-full border border-border/70 bg-background p-0.5 shadow-control"
          >
            <ToggleGroupItem
              value="preview"
              aria-label={`渲染 ${format}`}
              title={`渲染 ${format}`}
              className="rounded-full! [&_svg]:[stroke-width:1.75]"
            >
              <Eye data-icon="inline-start" />
              渲染
            </ToggleGroupItem>
            <ToggleGroupItem
              value="source"
              aria-label={`查看 ${format} 源码`}
              title={`查看 ${format} 源码`}
              className="rounded-full! [&_svg]:[stroke-width:1.75]"
            >
              <Code2 data-icon="inline-start" />
              源码
            </ToggleGroupItem>
          </ToggleGroup>
        )}
        <ButtonGroup variant="toolbar" aria-label="文件操作">
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

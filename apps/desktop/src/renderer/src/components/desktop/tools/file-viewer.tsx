/* eslint-disable react-refresh/only-export-components */
import { ExternalLink, FileCode2, FileText } from "lucide-react"
import { Streamdown } from "streamdown"

import { useAppearance } from "@renderer/components/appearance/appearance-provider"
import { streamdownComponents } from "@renderer/components/desktop/conversation-page/message/streamdown-components"
import { streamdownPlugins } from "@renderer/components/desktop/conversation-page/message/streamdown-plugins"
import { DesktopEmptyState } from "@renderer/components/desktop/desktop-empty-state"
import { Button } from "@renderer/components/ui/button"
import { ScrollArea } from "@renderer/components/ui/scroll-area"
import { Spinner } from "@renderer/components/ui/spinner"
import type { WorkspaceReadFileResult } from "@shared/workspace-types"

import { VirtualizedCodePreview } from "./virtualized-code-preview"
import { FileImagePreview } from "./file-image-preview"
import {
  canOpenHtmlInBrowser,
  shouldOfferHtmlBrowserOpen,
  type FileViewerType,
} from "./file-viewer-model"

export type FileViewMode = "preview" | "source"

export interface FileSearchMatch {
  index: number
  line: number
  column: number
}

export interface FileViewerTab {
  preview: WorkspaceReadFileResult
  type: FileViewerType
  projectPath?: string | null
}

export function mergeFileViewerTabs(
  current: FileViewerTab[],
  nextFileTab: FileViewerTab,
  projectPath: string | null
): FileViewerTab[] {
  const nextTab = { ...nextFileTab, projectPath }
  return [
    nextTab,
    ...current.filter(
      (tab) =>
        (tab.projectPath ?? null) === projectPath && tab.preview.path !== nextTab.preview.path
    ),
  ]
}

interface FileViewerProps {
  tabs: FileViewerTab[]
  activePath: string | null
  loadingPath: string | null
  viewMode: FileViewMode
  searchQuery: string
  searchMatchIndex: number
  searchMatches: FileSearchMatch[]
  targetLine?: number
  onOpenHtmlInBrowser: (projectPath: string, relativePath: string, name: string) => void
}

export function FileViewer({
  tabs,
  activePath,
  loadingPath,
  viewMode,
  searchQuery,
  searchMatchIndex,
  searchMatches,
  targetLine,
  onOpenHtmlInBrowser,
}: FileViewerProps): React.JSX.Element {
  const { resolvedTheme: themeType } = useAppearance()
  const activeTab = tabs.find((tab) => tab.preview.path === activePath) ?? null
  const showLargeHtmlAction = activeTab
    ? shouldOfferHtmlBrowserOpen(activeTab.preview.path, activeTab.preview.content ?? "") &&
      canOpenHtmlInBrowser(activeTab.preview.scope)
    : false

  if (tabs.length === 0 && !loadingPath) {
    return (
      <DesktopEmptyState
        icon={FileCode2}
        title="选择文件以预览"
        description="打开的文件会在顶部标签页里保留。"
      />
    )
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-background">
      <div className="min-h-0 min-w-0 flex-1">
        {loadingPath && loadingPath === activePath ? (
          <div className="text-ui-small flex h-full items-center justify-center gap-2 text-ui-muted">
            <Spinner />
            正在读取文件...
          </div>
        ) : activeTab?.type === "image" ? (
          activeTab.preview.previewBytes && activeTab.preview.mediaType ? (
            <FileImagePreview
              bytes={activeTab.preview.previewBytes}
              mediaType={activeTab.preview.mediaType}
              name={activeTab.preview.name}
            />
          ) : (
            <DocumentPlaceholder preview={activeTab.preview} />
          )
        ) : activeTab?.type === "document" ? (
          <DocumentPlaceholder preview={activeTab.preview} />
        ) : activeTab?.type === "markdown" && viewMode === "preview" ? (
          <MarkdownPreview preview={activeTab.preview} />
        ) : activeTab ? (
          <div className="flex h-full min-h-0 flex-col">
            {showLargeHtmlAction && activeTab.projectPath ? (
              <div className="flex h-10 shrink-0 items-center justify-between gap-3 border-b px-3 text-xs text-muted-foreground">
                <span>HTML 文件较大，当前展示源码</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    if (!activeTab.projectPath) return
                    onOpenHtmlInBrowser(
                      activeTab.projectPath,
                      activeTab.preview.path,
                      activeTab.preview.name
                    )
                  }}
                >
                  <ExternalLink />
                  在浏览器中打开
                </Button>
              </div>
            ) : null}
            <VirtualizedCodePreview
              key={activeTab.preview.path}
              preview={activeTab.preview}
              themeType={themeType}
              searchQuery={searchQuery}
              searchMatch={searchMatches[searchMatchIndex]}
              targetLine={targetLine}
            />
          </div>
        ) : (
          <DesktopEmptyState
            icon={FileCode2}
            title="选择文件以预览"
            description="打开的文件会在顶部标签页里保留。"
          />
        )}
      </div>
    </div>
  )
}

function MarkdownPreview({ preview }: { preview: WorkspaceReadFileResult }): React.JSX.Element {
  return (
    <ScrollArea className="h-full min-w-0" viewportClassName="p-0">
      <article className="desktop-markdown-preview text-ui-small mx-auto min-h-full w-full max-w-[920px] px-8 py-8 leading-7 text-content-foreground">
        <Streamdown
          mode="static"
          controls={false}
          lineNumbers
          plugins={streamdownPlugins}
          components={streamdownComponents}
          className="desktop-streamdown"
        >
          {preview.content ?? ""}
        </Streamdown>
      </article>
    </ScrollArea>
  )
}

function DocumentPlaceholder({ preview }: { preview: WorkspaceReadFileResult }): React.JSX.Element {
  const description =
    preview.imagePreviewError === "image_too_large"
      ? "图片太大，无法直接预览。"
      : preview.imagePreviewError === "image_unsupported"
        ? "无法安全预览这张图片。"
        : "这类文件的预览后续接入，这里先保留标签页占位。"

  return <DesktopEmptyState icon={FileText} title={preview.name} description={description} />
}

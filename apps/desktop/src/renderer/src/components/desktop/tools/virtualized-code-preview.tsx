import { DEFAULT_THEMES } from "@pierre/diffs"
import {
  File as PierreFile,
  type FileOptions,
  Virtualizer,
  useVirtualizer,
} from "@pierre/diffs/react"
import { useEffect, useMemo } from "react"

import { codeHighlighterOptions } from "@renderer/lib/code-highlight-options"
import { CodeHighlightingProvider } from "@renderer/components/ui/code-highlighting-provider"
import {
  createPreviewFile,
  resolveActiveLineIndex,
  resolvePreviewScrollTop,
} from "./virtualized-code-preview-model"
import type { FileSearchMatch } from "./file-viewer"
import type { WorkspaceReadFileResult } from "@shared/workspace-types"

interface VirtualizedCodePreviewProps {
  preview: WorkspaceReadFileResult
  themeType: "dark" | "light"
  searchQuery: string
  searchMatch?: FileSearchMatch
  targetLine?: number
}

const codeLineHeight = 20
const virtualizerConfig = { overscrollSize: 800 }
const codeViewerCSS = `
  :host {
    display: block;
    min-width: max-content;
    background: transparent;
    color: var(--content-foreground);
    font-family: var(--font-mono);
    font-size: var(--code-font-size);
    line-height: var(--code-line-height);
  }

  pre {
    margin: 0;
    min-width: max-content;
    background: transparent !important;
    font-family: var(--font-mono) !important;
    font-size: var(--code-font-size) !important;
    line-height: var(--code-line-height) !important;
  }
`

export function VirtualizedCodePreview({
  preview,
  themeType,
  searchQuery,
  searchMatch,
  targetLine,
}: VirtualizedCodePreviewProps): React.JSX.Element {
  const file = useMemo(() => createPreviewFile(preview), [preview])
  const options = useMemo<FileOptions<undefined>>(
    () => ({
      disableFileHeader: true,
      overflow: "scroll",
      preferredHighlighter: "shiki-js",
      theme: DEFAULT_THEMES,
      themeType,
      tokenizeMaxLineLength: codeHighlighterOptions.tokenizeMaxLineLength,
      unsafeCSS: codeViewerCSS,
    }),
    [themeType]
  )
  const searchLine = searchQuery && searchMatch ? searchMatch.line : undefined
  const scrollTop = resolvePreviewScrollTop({ searchLine, targetLine })
  const activeLineIndex = resolveActiveLineIndex({ searchLine, targetLine })

  return (
    <CodeHighlightingProvider>
      <Virtualizer
        className="h-full min-h-0 min-w-0 flex-1 overflow-auto"
        contentClassName="relative min-h-full min-w-max"
        config={virtualizerConfig}
      >
        <PreviewScrollController top={scrollTop} />
        {activeLineIndex !== null ? (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute left-0 z-0 h-5 min-w-full bg-amber-200/28 ring-1 ring-amber-300/30 dark:bg-amber-300/12 dark:ring-amber-200/10"
            style={{ top: activeLineIndex * codeLineHeight }}
          />
        ) : null}
        <PierreFile
          file={file}
          options={options}
          className="desktop-code-file relative z-10 min-w-max"
        />
      </Virtualizer>
    </CodeHighlightingProvider>
  )
}

function PreviewScrollController({ top }: { top: number | null }): null {
  const virtualizer = useVirtualizer()

  useEffect(() => {
    if (top === null) return
    virtualizer?.scrollTo({ top, behavior: "smooth" })
  }, [top, virtualizer])

  return null
}

import { useState, useEffect, useMemo, useRef } from "react"
import { ChevronLeft, ChevronRight, RefreshCw, Minus, Plus, MoveHorizontal } from "lucide-react"
import { Button } from "@renderer/components/ui/button"
import { Spinner } from "@renderer/components/ui/spinner"
import type { WorkspaceReadFileResult } from "@shared/workspace-types"
import {
  officePreviewHtml,
  officePreviewWidth,
  OFFICE_MIN_ZOOM,
  OFFICE_MAX_ZOOM,
} from "./office-preview-html"

export function OfficeDocumentPreview({
  preview,
  rootPath,
}: {
  preview: WorkspaceReadFileResult
  rootPath: string
}): React.JSX.Element {
  const [document, setDocument] = useState(preview.officePreview!)
  const [loading, setLoading] = useState(false),
    [error, setError] = useState<string | null>(null)
  const [manualZoom, setManualZoom] = useState<number | null>(null)
  const [viewportWidth, setViewportWidth] = useState(0)
  const frameRef = useRef<HTMLIFrameElement>(null)
  const width = useMemo(
    () => officePreviewWidth(document.html, document.format),
    [document.html, document.format]
  )
  // Leave room for the iframe's vertical scrollbar to avoid horizontal overflow.
  const fitZoom = viewportWidth > 0 ? Math.max(1, viewportWidth - 16) / width : 1
  const zoom = Math.min(OFFICE_MAX_ZOOM, Math.max(OFFICE_MIN_ZOOM, manualZoom ?? fitZoom))
  const html = useMemo(
    () => officePreviewHtml(document.html, zoom, preview.name, document.format),
    [document.html, document.format, zoom, preview.name]
  )
  const generation = useRef(0)
  useEffect(() => {
    setManualZoom(null)
  }, [rootPath, preview.path])
  useEffect(() => {
    const frame = frameRef.current
    if (!frame) return
    const update = () => setViewportWidth(frame.clientWidth)
    update()
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", update)
      return () => window.removeEventListener("resize", update)
    }
    const observer = new ResizeObserver(([entry]) => setViewportWidth(entry.contentRect.width))
    observer.observe(frame)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    setDocument(preview.officePreview!)
    setError(null)
    setLoading(false)
    return () => {
      generation.current++
    }
  }, [preview])
  const load = async (page: number) => {
    const id = ++generation.current
    setLoading(true)
    setError(null)
    try {
      const result = await window.desktop.workspace.readFile({
        rootPath,
        path: preview.path,
        officePage: page,
      })
      if (id !== generation.current) return
      if (!result.officePreview) throw new Error("无法生成办公文档预览。")
      setDocument(result.officePreview)
    } catch (cause) {
      if (id === generation.current)
        setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (id === generation.current) setLoading(false)
    }
  }
  return (
    <section
      className="flex h-full min-h-0 min-w-0 flex-col"
      aria-label={`${preview.name} 只读预览`}
    >
      <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b p-2 [&>button]:shrink-0">
        <Button
          variant="ghost"
          size="icon"
          aria-label="上一页"
          disabled={loading || document.page <= 1}
          onClick={() => void load(document.page - 1)}
        >
          <ChevronLeft />
        </Button>
        <span className="text-xs">
          {document.format === "xlsx" ? "工作表" : document.format === "docx" ? "文档" : "页"}{" "}
          {document.page}
          {document.pageCount ? ` / ${document.pageCount}` : ""}
        </span>
        <Button
          variant="ghost"
          size="icon"
          aria-label="下一页"
          disabled={
            loading ||
            document.page >= 200 ||
            (!!document.pageCount && document.page >= document.pageCount)
          }
          onClick={() => void load(document.page + 1)}
        >
          <ChevronRight />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="缩小预览"
          disabled={zoom <= OFFICE_MIN_ZOOM}
          onClick={() => setManualZoom(Math.max(OFFICE_MIN_ZOOM, zoom - 0.1))}
        >
          <Minus />
        </Button>
        <span
          className="w-11 text-center text-xs text-muted-foreground tabular-nums"
          aria-label="缩放比例"
        >
          {Math.round(zoom * 100)}%
        </span>
        <Button
          variant="ghost"
          size="icon"
          aria-label="放大预览"
          disabled={zoom >= OFFICE_MAX_ZOOM}
          onClick={() => setManualZoom(Math.min(OFFICE_MAX_ZOOM, zoom + 0.1))}
        >
          <Plus />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="适应宽度"
          title="适应宽度"
          aria-pressed={manualZoom === null}
          onClick={() => setManualZoom(null)}
        >
          <MoveHorizontal />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="刷新预览"
          disabled={loading}
          onClick={() => void load(document.page)}
        >
          {loading ? <Spinner /> : <RefreshCw />}
        </Button>
        <span
          className="ml-auto text-xs text-muted-foreground"
          title="只读预览，排版可能与 Office/WPS 不同"
        >
          只读
        </span>
      </div>
      {error ? (
        <p role="alert" className="p-3 text-sm break-words text-destructive">
          {error}
        </p>
      ) : null}
      <iframe
        ref={frameRef}
        title={`${preview.name} 文档内容`}
        sandbox=""
        referrerPolicy="no-referrer"
        srcDoc={html}
        className="min-h-0 w-full flex-1 border-0 bg-white"
      />
    </section>
  )
}

import { useState, useEffect, useRef } from "react"
import { ChevronLeft, ChevronRight, RefreshCw, Minus, Plus } from "lucide-react"
import { Button } from "@renderer/components/ui/button"
import { Spinner } from "@renderer/components/ui/spinner"
import type { WorkspaceReadFileResult } from "@shared/workspace-types"
import { officePreviewHtml } from "./office-preview-html"

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
  const [zoom, setZoom] = useState(preview.officePreview?.format === "pptx" ? 0.5 : 0.75)
  const generation = useRef(0)
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
    <section className="flex h-full min-h-0 flex-col" aria-label={`${preview.name} 只读预览`}>
      <div className="flex shrink-0 items-center gap-1 border-b p-2">
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
          disabled={zoom <= 0.25}
          onClick={() => setZoom((v) => Math.max(0.25, v - 0.1))}
        >
          <Minus />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="放大预览"
          disabled={zoom >= 2}
          onClick={() => setZoom((v) => Math.min(2, v + 0.1))}
        >
          <Plus />
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
        <span className="ml-auto text-xs text-muted-foreground">只读 · 近似排版</span>
      </div>
      {error ? (
        <p role="alert" className="p-3 text-sm break-words text-destructive">
          {error}
        </p>
      ) : null}
      <iframe
        title={`${preview.name} 文档内容`}
        sandbox=""
        referrerPolicy="no-referrer"
        srcDoc={officePreviewHtml(document.html, zoom)}
        className="min-h-0 w-full flex-1 border-0 bg-white"
      />
    </section>
  )
}

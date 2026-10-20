import { useEffect, useRef, useState } from "react"
import { RefreshCw } from "lucide-react"
import { useAppearance } from "@renderer/components/appearance/appearance-provider"
import { Button } from "@renderer/components/ui/button"
import { Spinner } from "@renderer/components/ui/spinner"
import { DOCUMENT_PREVIEW_URL } from "@shared/document-preview"
import type { WorkspaceReadFileResult } from "@shared/workspace-types"

export function LocalDocumentPreview({
  preview,
}: {
  preview: WorkspaceReadFileResult
}): React.JSX.Element {
  const frame = useRef<HTMLIFrameElement>(null)
  const section = useRef<HTMLElement>(null)
  const ready = useRef(false)
  const { resolvedTheme } = useAppearance()
  const [revision, setRevision] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    setError(null)
    const send = () => {
      const style = section.current && getComputedStyle(section.current)
      frame.current?.contentWindow?.postMessage(
        {
          type: "document:open",
          name: preview.name,
          bytes: preview.documentPreview?.bytes,
          colors: style
            ? {
                background: style.backgroundColor,
                foreground: style.color,
                border: style.borderTopColor,
              }
            : undefined,
        },
        "*"
      )
    }
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return
      if (event.data?.type === "document:ready") {
        ready.current = true
        send()
      }
      if (["document:loaded", "document:error"].includes(event.data?.type))
        window.clearTimeout(timeout)
      if (event.data?.type === "document:loaded") setLoading(false)
      if (event.data?.type === "document:error") {
        setLoading(false)
        setError(typeof event.data.detail === "string" ? event.data.detail : "文档预览失败。")
      }
    }
    const timeout = window.setTimeout(() => {
      setLoading(false)
      setError("文档加载超时，请重试或使用本地应用打开。")
    }, 60_000)
    window.addEventListener("message", receive)
    if (ready.current) send()
    return () => {
      window.clearTimeout(timeout)
      window.removeEventListener("message", receive)
    }
  }, [preview, revision, resolvedTheme])

  return (
    <section
      ref={section}
      className="relative flex h-full min-h-0 flex-col border-border bg-muted/30 text-foreground"
      aria-label={`${preview.name} 只读预览`}
    >
      <iframe
        ref={frame}
        title={`${preview.name} 文档内容`}
        src={DOCUMENT_PREVIEW_URL}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        className="min-h-0 w-full flex-1 border-0"
      />
      {loading ? (
        <div
          role="status"
          className="absolute inset-0 flex items-center justify-center gap-2 bg-background/80 text-sm text-muted-foreground"
        >
          <Spinner />
          正在预览…
        </div>
      ) : null}
      {error ? (
        <div
          role="alert"
          className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background p-6 text-sm"
        >
          <p className="max-w-md break-words text-destructive">{error}</p>
          <Button variant="control" shape="pill" onClick={() => setRevision((value) => value + 1)}>
            <RefreshCw data-icon="inline-start" />
            重试
          </Button>
        </div>
      ) : null}
    </section>
  )
}

import { useEffect, useState } from "react"
import { FileText } from "lucide-react"
import { DesktopEmptyState } from "@renderer/components/desktop/shared/desktop-empty-state"
import { LocalDocumentPreview } from "@renderer/components/desktop/tools/files/local-document-preview"
import { Spinner } from "@renderer/components/ui/spinner"
import type { AttachmentDocumentPreview } from "@shared/document-preview"

export function AttachmentDocumentPanel({ assetId }: { assetId: string }): React.JSX.Element {
  const [result, setResult] = useState<AttachmentDocumentPreview | Error | null>(null)
  useEffect(() => {
    let cancelled = false
    void window.desktop.attachments.readDocumentPreview({ assetId }).then(
      (preview) => { if (!cancelled) setResult(preview) },
      (error: unknown) => {
        if (!cancelled) setResult(error instanceof Error ? error : new Error(String(error)))
      }
    )
    return () => { cancelled = true }
  }, [assetId])

  if (result instanceof Error) {
    return <DesktopEmptyState icon={FileText} size="sm" title="无法预览附件" description={result.message} />
  }
  if (!result) {
    return <div role="status" className="flex h-full items-center justify-center gap-2 text-ui-muted">
      <Spinner /> 正在读取附件…
    </div>
  }
  return <LocalDocumentPreview name={result.name} bytes={result.bytes} />
}

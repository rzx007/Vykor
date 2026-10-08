import { useEffect, useState } from "react"
import { Button } from "@renderer/components/ui/button"
import { AttachmentImagePreview } from "../composer/attachment-image-preview"
import { useImageViewer } from "@renderer/components/desktop/image-viewer/image-viewer-provider"
import type { DesktopSessionPart } from "@shared/session-types"
import type { DesktopAttachmentPreview } from "@shared/attachment-types"
import { safeImageMediaTypeFromName } from "@shared/safe-image-preview"

export function readImagePath(part: DesktopSessionPart): string | null {
  if (part.toolName !== "Read") return null
  let input = part.input
  for (let depth = 0; input && depth < 8; depth++) {
    const keys = Object.keys(input)
    const key = keys[0]
    if (keys.length !== 1 || !key || !["arguments", "args", "parameters"].includes(key)) break
    const nested = input[key]
    if (!nested || typeof nested !== "object" || Array.isArray(nested)) break
    input = nested as Record<string, unknown>
  }
  const path = input?.file_path
  return input?.info_only !== true && typeof path === "string" && safeImageMediaTypeFromName(path) ? path : null
}

export function ReadImagePreview({ part, path, calling }: { part: DesktopSessionPart; path: string; calling: boolean }) {
  const viewer = useImageViewer()
  const [attempt, setAttempt] = useState(0)
  const [loaded, setLoaded] = useState<{ key: string; url?: string; preview?: DesktopAttachmentPreview; error?: string }>()
  const key = JSON.stringify([part.sessionId, part.messageId, part.id, part.updatedAt, part.status, path, attempt])
  useEffect(() => {
    if (calling) return
    let current = true
    let url: string | undefined
    void window.desktop.sessions.readToolImagePreview({ sessionId: part.sessionId, messageId: part.messageId, partId: part.id }).then(preview => {
      if (!current) return
      url = URL.createObjectURL(new Blob([preview.bytes], { type: preview.mediaType }))
      setLoaded({ key, url, preview })
    }).catch(error => {
      if (current) setLoaded({ key, error: error instanceof Error ? error.message : "无法读取图片" })
    })
    return () => { current = false; if (url) URL.revokeObjectURL(url) }
    // key 完整标识当前记录和重试次数；不随对象重新创建而重载图片。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, calling])
  const name = path.split(/[\\/]/).pop() || path
  const visible = loaded?.key === key ? loaded : undefined
  return (
    <div className="px-3 py-3">
      {visible?.error ? (
        <div role="status" className="flex items-center gap-2 text-xs text-ui-muted">
          <span>{visible.error}</span>
          <Button variant="ghost" size="sm" onClick={() => setAttempt(value => value + 1)}>重试</Button>
        </div>
      ) : visible?.url && visible.preview ? (
        <AttachmentImagePreview
          src={visible.url} displayName={name}
          onError={() => setLoaded({ key, error: "图片无法显示，请重试" })}
          onOpen={viewer ? () => viewer.openImage({ kind: "file", path, name, bytes: visible.preview!.bytes, mediaType: visible.preview!.mediaType }) : undefined}
        />
      ) : <p role="status" className="text-xs text-ui-muted">{calling ? "等待图片读取完成…" : "正在加载图片…"}</p>}
    </div>
  )
}

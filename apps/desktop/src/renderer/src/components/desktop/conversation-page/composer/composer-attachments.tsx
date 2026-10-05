import { FileArchive, FileImage, FileSpreadsheet, FileText, RotateCcw, X } from "lucide-react"
import { useEffect, useState, type ReactNode } from "react"

import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentProgress,
  AttachmentTitle,
} from "@renderer/components/ui/attachment"
import {
  resolveDesktopAttachmentCompatibility,
  type DesktopAttachmentDraft,
} from "@shared/attachment-types"
import { AttachmentImagePreview, attachmentImageActionClassName } from "./attachment-image-preview"
import { useImageViewer } from "@renderer/components/desktop/image-viewer/image-viewer-provider"

export function ComposerAttachments({
  attachments,
  readOnly = false,
  onCancel,
  onRetry,
  onRemove,
}: {
  attachments: readonly DesktopAttachmentDraft[]
  readOnly?: boolean
  onCancel: (draftId: string) => void
  onRetry: (draftId: string) => void
  onRemove: (draftId: string) => void
}): React.JSX.Element | null {
  if (attachments.length === 0) return null

  const containsImage = attachments.some(isImageAttachment)
  const containsFile = attachments.some((attachment) => !isImageAttachment(attachment))
  const alignMixedAttachmentHeights = containsImage && containsFile

  return (
    <AttachmentGroup aria-label="待发送附件" className="px-3 pt-2">
      {attachments.map((attachment) => (
        <ComposerAttachmentCard
          key={attachment.draftId}
          attachment={attachment}
          readOnly={readOnly}
          onCancel={onCancel}
          onRetry={onRetry}
          onRemove={onRemove}
          alignMixedAttachmentHeights={alignMixedAttachmentHeights}
        />
      ))}
    </AttachmentGroup>
  )
}

function ComposerAttachmentCard({
  attachment,
  readOnly,
  onCancel,
  onRetry,
  onRemove,
  alignMixedAttachmentHeights,
}: {
  attachment: DesktopAttachmentDraft
  readOnly: boolean
  onCancel: (draftId: string) => void
  onRetry: (draftId: string) => void
  onRemove: (draftId: string) => void
  alignMixedAttachmentHeights: boolean
}): React.JSX.Element {
  const viewer = useImageViewer()
  const previewUrl = useAttachmentPreviewUrl(attachment)
  const [failedPreviewUrl, setFailedPreviewUrl] = useState<string | null>(null)
  const visiblePreviewUrl = previewUrl && previewUrl !== failedPreviewUrl ? previewUrl : null
  const state =
    attachment.status === "uploading"
      ? "uploading"
      : attachment.status === "ready"
        ? "done"
        : "error"
  const mediaType = attachment.mediaType ?? attachment.declaredMediaType
  const compatibility = resolveDesktopAttachmentCompatibility(attachment)
  const fileIcon = attachmentIcon(mediaType)
  const errorMessage =
    attachment.error?.message ??
    (attachment.status === "cancelled" ? "上传已取消" : null) ??
    (attachment.status === "ready" && !compatibility.supported
      ? (compatibility.reason ?? null)
      : null)

  if (visiblePreviewUrl) {
    return (
      <AttachmentImagePreview
        src={visiblePreviewUrl}
        displayName={attachment.displayName}
        alignMixedAttachmentHeights={alignMixedAttachmentHeights}
        onOpen={
          viewer && attachment.assetId
            ? () =>
                viewer.openImage({
                  assetId: attachment.assetId!,
                  name: attachment.displayName,
                  draftId: attachment.draftId,
                  readOnly,
                })
            : undefined
        }
        onError={() => setFailedPreviewUrl(visiblePreviewUrl)}
        actions={
          !readOnly ? (
            <AttachmentAction
              aria-label={`移除附件 ${attachment.displayName}`}
              title="移除附件"
              className={attachmentImageActionClassName}
              onClick={() => onRemove(attachment.draftId)}
            >
              <X />
            </AttachmentAction>
          ) : null
        }
      />
    )
  }

  return (
    <Attachment
      data-display="file-card"
      state={attachment.status === "ready" && !compatibility.supported ? "error" : state}
      size="sm"
      className={`max-w-64 flex-nowrap ${alignMixedAttachmentHeights ? "h-20" : ""}`}
    >
      <AttachmentMedia variant={visiblePreviewUrl ? "image" : "icon"}>
        {visiblePreviewUrl ? (
          <img
            src={visiblePreviewUrl}
            alt=""
            onError={() => setFailedPreviewUrl(visiblePreviewUrl)}
          />
        ) : (
          fileIcon
        )}
      </AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle title={attachment.displayName}>{attachment.displayName}</AttachmentTitle>
        <AttachmentDescription aria-live={errorMessage ? "polite" : undefined}>
          {errorMessage ?? attachmentDescription(attachment, mediaType)}
        </AttachmentDescription>
        {attachment.status === "uploading" && attachment.progress !== null ? (
          <AttachmentProgress
            value={attachment.progress}
            label={`${attachment.displayName} 上传进度`}
          />
        ) : null}
      </AttachmentContent>
      {!readOnly ? (
        <AttachmentActions>
          {attachment.status === "uploading" ? (
            <AttachmentAction
              aria-label={`取消上传 ${attachment.displayName}`}
              title="取消上传"
              onClick={() => onCancel(attachment.draftId)}
            >
              <X />
            </AttachmentAction>
          ) : null}
          {attachment.status === "failed" && attachment.error?.retryable ? (
            <AttachmentAction
              aria-label={`重试上传 ${attachment.displayName}`}
              title="重试上传"
              onClick={() => onRetry(attachment.draftId)}
            >
              <RotateCcw />
            </AttachmentAction>
          ) : null}
          {attachment.status !== "uploading" ? (
            <AttachmentAction
              aria-label={`移除附件 ${attachment.displayName}`}
              title="移除附件"
              onClick={() => onRemove(attachment.draftId)}
            >
              <X />
            </AttachmentAction>
          ) : null}
        </AttachmentActions>
      ) : null}
    </Attachment>
  )
}

function isImageAttachment(attachment: DesktopAttachmentDraft): boolean {
  return (attachment.mediaType ?? attachment.declaredMediaType).startsWith("image/")
}

function useAttachmentPreviewUrl(attachment: DesktopAttachmentDraft): string | null {
  const [preview, setPreview] = useState<{ assetId: string; url: string } | null>(null)
  const mediaType = attachment.mediaType ?? attachment.declaredMediaType
  const previewable =
    attachment.status === "ready" && Boolean(attachment.assetId) && mediaType.startsWith("image/")

  useEffect(() => {
    if (!previewable || !attachment.assetId) {
      return
    }

    let disposed = false
    let objectUrl: string | null = null
    void window.desktop.attachments
      .readPreview({ assetId: attachment.assetId })
      .then((preview) => {
        if (disposed) return
        objectUrl = URL.createObjectURL(new Blob([preview.bytes], { type: preview.mediaType }))
        setPreview({ assetId: attachment.assetId!, url: objectUrl })
      })
      .catch(() => {
        if (!disposed) setPreview(null)
      })

    return () => {
      disposed = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [attachment.assetId, previewable])

  return previewable && preview && preview.assetId === attachment.assetId ? preview.url : null
}

function attachmentDescription(attachment: DesktopAttachmentDraft, mediaType: string): string {
  const kind = fileKind(mediaType)
  if (attachment.status === "uploading") {
    const percent = attachment.progress === null ? null : Math.round(attachment.progress * 100)
    return percent === null
      ? `正在上传 · ${formatBytes(attachment.sizeBytes)}`
      : `正在上传 ${percent}%`
  }
  return `${kind} · ${formatBytes(attachment.sizeBytes)}`
}

function fileKind(mediaType: string): string {
  if (mediaType.startsWith("image/")) return "图片"
  if (mediaType.includes("pdf")) return "PDF"
  if (mediaType.includes("word")) return "Word"
  if (mediaType.includes("sheet") || mediaType.includes("excel")) return "表格"
  if (mediaType.startsWith("text/")) return "文本"
  return "文件"
}

function attachmentIcon(mediaType: string): ReactNode {
  if (mediaType.startsWith("image/")) return <FileImage />
  if (mediaType.includes("sheet") || mediaType.includes("excel")) return <FileSpreadsheet />
  if (mediaType.includes("zip") || mediaType.includes("compressed")) return <FileArchive />
  return <FileText />
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

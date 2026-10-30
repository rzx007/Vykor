import { CircleAlert, CircleCheck, RotateCcw, X } from "lucide-react"
import { createElement, useEffect, useState } from "react"
import { getFileIcon } from "@renderer/components/desktop/tools/files/file-icons"

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
import { Spinner } from "@renderer/components/ui/spinner"
import {
  resolveDesktopAttachmentCompatibility,
  type DesktopAttachmentDraft,
} from "@shared/attachment-types"
import { AttachmentImagePreview, attachmentImageActionClassName } from "./attachment-image-preview"
import {
  ImageGalleryProvider,
  useImageViewer,
} from "@renderer/components/desktop/image-viewer/image-viewer-provider"
import { collectDraftImageGallery } from "@renderer/components/desktop/image-viewer/image-gallery"

export function ComposerAttachments({
  attachments,
  composerScope,
  imageCanFeedback,
  readOnly = false,
  onCancel,
  onRetry,
  onRemove,
}: {
  attachments: readonly DesktopAttachmentDraft[]
  composerScope?: string
  imageCanFeedback?: () => boolean
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
    <ImageGalleryProvider
      getGallery={() =>
        collectDraftImageGallery(attachments, composerScope, readOnly, imageCanFeedback)
      }
      readOnly={readOnly || !composerScope}
    >
      <div className="px-3 pt-2">
        <AttachmentGroup aria-label="待发送附件">
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
      </div>
    </ImageGalleryProvider>
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
  const preview = useAttachmentPreviewUrl(attachment)
  const previewUrl = preview.url
  const [failedPreviewUrl, setFailedPreviewUrl] = useState<string | null>(null)
  const visiblePreviewUrl = previewUrl && previewUrl !== failedPreviewUrl ? previewUrl : null
  const previewFailed = preview.failed || Boolean(previewUrl && previewUrl === failedPreviewUrl)
  const previewMessage = previewFailed
    ? "预览读取失败，附件仍已就绪"
    : preview.loading
      ? "正在读取预览，附件已就绪"
      : null
  const state =
    attachment.status === "uploading"
      ? "uploading"
      : attachment.status === "ready"
        ? "done"
        : "error"
  const mediaType = attachment.mediaType ?? attachment.declaredMediaType
  const compatibility = resolveDesktopAttachmentCompatibility(attachment)
  const errorMessage =
    attachment.error?.message ??
    (attachment.status === "cancelled" ? "上传已取消" : null) ??
    (attachment.status === "ready" && !compatibility.supported
      ? (compatibility.reason ?? null)
      : null)
  const indicatorState = attachment.status === "ready" && !compatibility.supported ? "error" : state
  const statusLabel =
    indicatorState === "uploading"
      ? attachment.progress === 1
        ? "正在确认附件"
        : "正在上传"
      : indicatorState === "done"
        ? "已就绪"
        : (errorMessage ?? "附件需要处理")
  const statusIndicator = (
    <ComposerAttachmentStatus
      state={indicatorState}
      label={`${attachment.displayName}：${statusLabel}`}
    />
  )

  if (visiblePreviewUrl) {
    return (
      <AttachmentImagePreview
        src={visiblePreviewUrl}
        displayName={attachment.displayName}
        alignMixedAttachmentHeights={alignMixedAttachmentHeights}
        statusIndicator={statusIndicator}
        onOpen={
          viewer && attachment.assetId
            ? () =>
                viewer.openImage({
                  kind: "attachment",
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
      state={indicatorState}
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
          createElement(getFileIcon(attachment.displayName, mediaType))
        )}
      </AttachmentMedia>
      <AttachmentContent>
        <div className="flex min-w-0 items-center gap-1.5">
          <AttachmentTitle title={attachment.displayName} className="min-w-0 flex-1">
            {attachment.displayName}
          </AttachmentTitle>
          {statusIndicator}
        </div>
        <AttachmentDescription
          title={errorMessage ?? previewMessage ?? undefined}
          className={errorMessage || previewFailed ? "whitespace-normal" : undefined}
          aria-live={errorMessage || previewFailed ? "polite" : undefined}
        >
          {errorMessage ?? previewMessage ?? attachmentDescription(attachment, mediaType)}
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
          {previewFailed ? (
            <AttachmentAction
              aria-label={`重试预览 ${attachment.displayName}`}
              title="重试预览"
              onClick={() => {
                setFailedPreviewUrl(null)
                preview.retry()
              }}
            >
              <RotateCcw />
            </AttachmentAction>
          ) : null}
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

function ComposerAttachmentStatus({
  state,
  label,
}: {
  state: "uploading" | "done" | "error"
  label: string
}): React.JSX.Element {
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={`inline-flex size-3.5 shrink-0 items-center justify-center ${
        state === "error" ? "text-destructive" : "text-muted-foreground"
      }`}
    >
      {state === "uploading" ? (
        <Spinner
          role="presentation"
          aria-hidden="true"
          aria-label={undefined}
          className="size-3.5 motion-reduce:animate-none"
          strokeWidth={1.75}
        />
      ) : state === "done" ? (
        <CircleCheck aria-hidden="true" className="size-3.5" strokeWidth={1.75} />
      ) : (
        <CircleAlert aria-hidden="true" className="size-3.5" strokeWidth={1.75} />
      )}
    </span>
  )
}

function isImageAttachment(attachment: DesktopAttachmentDraft): boolean {
  return (attachment.mediaType ?? attachment.declaredMediaType).startsWith("image/")
}

function useAttachmentPreviewUrl(attachment: DesktopAttachmentDraft) {
  const [attempt, setAttempt] = useState(0)
  const [preview, setPreview] = useState<{
    assetId: string
    attempt: number
    url: string | null
    failed?: boolean
  } | null>(null)
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
        setPreview({ assetId: attachment.assetId!, attempt, url: objectUrl })
      })
      .catch(() => {
        if (!disposed)
          setPreview({ assetId: attachment.assetId!, attempt, url: null, failed: true })
      })

    return () => {
      disposed = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [attachment.assetId, previewable, attempt])

  const current =
    previewable && preview && preview.assetId === attachment.assetId && preview.attempt === attempt
      ? preview
      : null
  return {
    url: current?.url ?? null,
    loading: previewable && !current,
    failed: Boolean(current?.failed),
    retry: () => setAttempt((value) => value + 1),
  }
}

function attachmentDescription(attachment: DesktopAttachmentDraft, mediaType: string): string {
  const kind = fileKind(mediaType)
  if (attachment.status === "uploading") {
    const percent = attachment.progress === null ? null : Math.round(attachment.progress * 100)
    if (percent === 100) return "正在确认附件，请稍候"
    return percent === null
      ? `正在上传 · ${formatBytes(attachment.sizeBytes)}`
      : `正在上传 ${percent}%`
  }
  return `${attachment.status === "ready" ? "已就绪 · " : ""}${kind} · ${formatBytes(attachment.sizeBytes)}`
}

function fileKind(mediaType: string): string {
  if (mediaType.startsWith("image/")) return "图片"
  if (mediaType.includes("pdf")) return "PDF"
  if (mediaType.includes("word")) return "Word"
  if (mediaType.includes("sheet") || mediaType.includes("excel")) return "表格"
  if (mediaType.startsWith("text/")) return "文本"
  return "文件"
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

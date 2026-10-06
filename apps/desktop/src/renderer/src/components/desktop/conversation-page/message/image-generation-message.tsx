import { AlertCircle, Ban, ChevronRight, ChevronUp, ImageIcon, Sparkles } from "lucide-react"
import { useEffect, useState } from "react"

import { cn } from "@renderer/lib/utils"
import type { DesktopAttachmentSessionPart, DesktopSessionPart } from "@shared/session-types"

import { MessageAttachment } from "./message-attachment"
import { useToolDetails } from "./use-tool-details"

import {
  formatValue,
  normalizeImageGenerationRatio,
  type ImageGenerationRatio,
} from "./message-render-model"

const ratioClassNames: Record<ImageGenerationRatio, string> = {
  "1:1": "aspect-square max-w-sm",
  "3:4": "aspect-[3/4] max-w-xs",
  "4:3": "aspect-[4/3] max-w-md",
  "16:9": "aspect-video max-w-xl",
  "9:16": "aspect-[9/16] max-w-64",
  "2:3": "aspect-[2/3] max-w-72",
  "3:2": "aspect-[3/2] max-w-lg",
  "21:9": "aspect-[21/9] max-w-xl",
}

const placeholderCanvasClassNames: Record<ImageGenerationRatio, string> = {
  "1:1": "h-16 aspect-square",
  "3:4": "h-20 aspect-[3/4]",
  "4:3": "w-20 aspect-[4/3]",
  "16:9": "w-24 aspect-video",
  "9:16": "h-24 aspect-[9/16]",
  "2:3": "h-20 aspect-[2/3]",
  "3:2": "w-20 aspect-[3/2]",
  "21:9": "w-24 aspect-[21/9]",
}

const galleryClassNames = {
  single: "grid-cols-1",
  pair: "grid-cols-2",
  triple: "grid-cols-2 grid-rows-2",
  quad: "grid-cols-2",
} as const

export function ImageGenerationMessage({
  call,
  hasAttachments,
  streaming,
}: {
  call: DesktopSessionPart
  hasAttachments: boolean
  streaming: boolean
}): React.JSX.Element | null {
  const running = call.status === "pending" || call.status === "running"
  const [currentTime, setCurrentTime] = useState(() => Date.now())
  const [detailsOpen, setDetailsOpen] = useState(false)
  const details = useToolDetails(
    call,
    undefined,
    detailsOpen && call.status === "failed" && call.bodyView?.output === "preview"
  )

  useEffect(() => {
    if (!running) return
    const timer = window.setInterval(() => setCurrentTime(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [running])

  if (call.status === "completed" && hasAttachments) return null
  const interrupted = call.status === "interrupted" || call.metadata.failureKind === "interrupted"
  if (interrupted) {
    return (
      <ImageGenerationStatusCard
        icon={<Ban className="size-4 text-ui-muted/80" />}
        title="图片生成已取消"
      />
    )
  }
  if (call.status === "failed") {
    return (
      <ImageGenerationStatusCard
        icon={<AlertCircle className="size-4 text-amber-600/80 dark:text-amber-400/80" />}
        title="这次没有生成出图片"
        tone="error"
        detail={formatValue(details.call.output)}
        preview={call.bodyView?.output === "preview" && details.preview}
        detailMessage={
          details.error ?? (detailsOpen ? "正在加载完整详情；当前仅显示预览。" : "当前仅显示预览。")
        }
        onDetailToggle={setDetailsOpen}
      />
    )
  }
  if (call.status === "completed") {
    return (
      <ImageGenerationStatusCard
        icon={
          streaming ? (
            <Sparkles className="size-4 text-violet-500/80" />
          ) : (
            <AlertCircle className="size-4 text-amber-600/80 dark:text-amber-400/80" />
          )
        }
        title={streaming ? "正在整理生成结果…" : "图片已生成，但附件暂未显示"}
        tone={streaming ? "default" : "warning"}
      />
    )
  }

  const elapsedSeconds = Math.max(0, Math.floor((currentTime - call.createdAt) / 1_000))
  const ratio = normalizeImageGenerationRatio(call.input?.ratio)
  const longRunning = elapsedSeconds > 45
  const showElapsed = elapsedSeconds >= 10

  return (
    <section
      className="w-full max-w-72 overflow-hidden rounded-xl border border-border/70 bg-muted/20"
      aria-label="图片生成状态"
    >
      <header className="px-3 py-2.5 text-xs text-ui-muted">
        <div className="flex items-center gap-2">
          <span className="size-2 rounded-full bg-violet-500 shadow-[0_0_0_4px_rgba(139,92,246,0.13)]" />
          <span
            data-image-generation-title
            className="font-medium text-foreground/80"
            aria-hidden="true"
          >
            正在生成图片
          </span>
          <span
            data-image-generation-announcement
            className="sr-only"
            aria-live="polite"
            aria-atomic="true"
          >
            {longRunning ? "图片生成耗时较长" : "正在生成图片"}
          </span>
        </div>
        {showElapsed ? (
          <p data-image-generation-elapsed className="text-ui-caption mt-1 pl-4 tabular-nums">
            已等待 {elapsedSeconds} 秒{longRunning ? " · 生成时间可能较长" : null}
          </p>
        ) : null}
      </header>
      <div
        data-image-placeholder
        className="grid h-44 w-full place-items-center overflow-hidden border-t border-border/60 bg-gradient-to-br from-muted/70 via-background to-violet-500/10"
      >
        <div
          data-placeholder-canvas
          data-image-ratio={ratio}
          className={cn(
            "grid place-items-center rounded-lg border border-border/70 bg-background/80 text-ui-muted/55 shadow-sm motion-safe:animate-pulse",
            placeholderCanvasClassNames[ratio]
          )}
          aria-hidden="true"
        >
          <ImageIcon className="size-5" strokeWidth={1.5} />
        </div>
      </div>
    </section>
  )
}

export function GeneratedImageGallery({
  parts,
  ratio,
}: {
  parts: DesktopAttachmentSessionPart[]
  ratio: ImageGenerationRatio
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const visible = expanded ? parts : parts.slice(0, 4)
  const hiddenCount = parts.length - visible.length
  const layout = galleryLayout(visible.length)

  return (
    <section className="w-full max-w-xl" aria-label="生成的附件">
      <div
        data-generated-image-gallery
        data-image-count={parts.length}
        data-image-ratio={ratio}
        data-layout={layout}
        className={cn(
          "grid min-h-48 w-full gap-1.5 overflow-hidden rounded-xl",
          galleryClassNames[layout],
          layout === "single" && ratioClassNames[ratio],
          layout !== "single" && !expanded && "aspect-square max-w-lg"
        )}
      >
        {visible.map((part, index) => (
          <div
            key={part.id}
            data-generated-image
            className={cn(
              "relative min-h-0 min-w-0 overflow-hidden rounded-lg",
              expanded && "aspect-square",
              layout === "triple" && index === 0 && "row-span-2"
            )}
          >
            <MessageAttachment part={part} fill />
            {hiddenCount > 0 && index === visible.length - 1 ? (
              <button
                type="button"
                aria-label={`展开全部 ${parts.length} 张图片`}
                onClick={() => setExpanded(true)}
                className="absolute inset-0 z-20 grid place-items-center bg-black/55 text-xl font-semibold text-white backdrop-blur-[1px]"
              >
                +{hiddenCount}
              </button>
            ) : null}
          </div>
        ))}
      </div>
      {expanded && parts.length > 4 ? (
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="mt-1.5 flex h-7 items-center gap-1 text-xs text-ui-muted hover:text-foreground"
        >
          <ChevronUp className="size-3.5" />
          收起
        </button>
      ) : null}
    </section>
  )
}

function galleryLayout(count: number): keyof typeof galleryClassNames {
  if (count <= 1) return "single"
  if (count === 2) return "pair"
  if (count === 3) return "triple"
  return "quad"
}

function ImageGenerationStatusCard({
  icon,
  title,
  tone = "default",
  detail,
  preview,
  detailMessage,
  onDetailToggle,
}: {
  icon: React.ReactNode
  title: string
  tone?: "default" | "warning" | "error"
  detail?: string
  preview?: boolean
  detailMessage?: string
  onDetailToggle?: (open: boolean) => void
}): React.JSX.Element {
  const normalizedDetail = detail?.trim()
  const statusRowClassName = "flex w-fit items-center gap-2 py-1.5"

  return (
    <section
      data-image-generation-status
      className="max-w-xl text-xs text-foreground/80"
      aria-label={tone === "error" ? "图片生成失败" : "图片生成状态"}
    >
      {tone === "error" && normalizedDetail ? (
        <details className="group" onToggle={(event) => onDetailToggle?.(event.currentTarget.open)}>
          <summary
            data-image-generation-status-row
            aria-live="polite"
            aria-atomic="true"
            className={cn(
              statusRowClassName,
              "cursor-pointer list-none rounded-md pr-1 select-none hover:text-foreground [&::-webkit-details-marker]:hidden"
            )}
          >
            {icon}
            <span className="font-medium">{title}</span>
            <span className="text-ui-muted">{preview ? "详情（预览）" : "详情"}</span>
            <ChevronRight className="size-3.5 text-ui-muted transition-transform group-open:rotate-90" />
          </summary>
          {preview ? (
            <p role="status" className="mt-1 ml-6 text-ui-muted">
              {detailMessage}
            </p>
          ) : null}
          <pre className="text-ui-caption mt-1 ml-6 max-h-40 overflow-auto rounded-lg bg-muted/40 px-3 py-2 leading-relaxed whitespace-pre-wrap text-ui-muted">
            {normalizedDetail}
          </pre>
        </details>
      ) : (
        <div
          data-image-generation-status-row
          className={statusRowClassName}
          aria-live="polite"
          aria-atomic="true"
        >
          {icon}
          <span className="font-medium">{title}</span>
        </div>
      )}
    </section>
  )
}

import type { ReactNode } from "react"

import { Attachment, AttachmentActions } from "@renderer/components/ui/attachment"
import { cn } from "@renderer/lib/utils"

export const attachmentImageActionClassName =
  "rounded-full bg-background/85 text-foreground shadow-sm backdrop-blur-sm hover:bg-background"

export function AttachmentImagePreview({
  src,
  displayName,
  alignMixedAttachmentHeights = false,
  fill = false,
  statusIndicator,
  actions,
  actionsClassName,
  onError,
  onOpen,
}: {
  src: string
  displayName: string
  alignMixedAttachmentHeights?: boolean
  fill?: boolean
  statusIndicator?: ReactNode
  actions?: ReactNode
  actionsClassName?: string
  onError: () => void
  onOpen?: () => void
}): React.JSX.Element {
  return (
    <Attachment
      data-display="image-preview"
      state="done"
      aria-label={displayName}
      className={
        fill
          ? "size-full min-w-0 flex-nowrap overflow-hidden border-border/50 bg-muted p-0"
          : alignMixedAttachmentHeights
            ? "h-20 w-20 min-w-0 flex-nowrap overflow-hidden border-border/50 bg-muted p-0"
            : "size-24 min-w-0 flex-nowrap overflow-hidden border-border/50 bg-muted p-0"
      }
    >
      {onOpen ? (
        <button
          type="button"
          aria-label={`查看图片 ${displayName}`}
          className="size-full rounded-[inherit] outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          onClick={onOpen}
        >
          <img src={src} alt={displayName} className="size-full object-cover" onError={onError} />
        </button>
      ) : (
        <img src={src} alt={displayName} className="size-full object-cover" onError={onError} />
      )}
      {statusIndicator ? (
        <div className="pointer-events-none absolute right-1.5 bottom-1.5 flex items-center justify-center rounded-full bg-background/85 p-0.5">
          {statusIndicator}
        </div>
      ) : null}
      {actions ? (
        <AttachmentActions className={cn("absolute top-1.5 right-1.5 gap-1", actionsClassName)}>
          {actions}
        </AttachmentActions>
      ) : null}
    </Attachment>
  )
}

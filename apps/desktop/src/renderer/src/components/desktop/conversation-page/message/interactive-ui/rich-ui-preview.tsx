import type { ReactNode } from "react"
import type { RichUiContent } from "@shared/rich-ui-content"
import { CardContent } from "@renderer/components/ui/card"
import { Spinner } from "@renderer/components/ui/spinner"
import { cn } from "@renderer/lib/utils"

const previewSizes = {
  image: "",
  video: "aspect-video",
  html: "h-[min(24rem,55dvh)]",
}

export function RichUiPreview({
  kind,
  status,
  children,
}: {
  kind: RichUiContent["kind"]
  status?: string
  children?: ReactNode
}) {
  return (
    <CardContent>
      <div
        role={status ? "status" : undefined}
        className={cn(
          "relative overflow-hidden rounded-lg bg-muted/30",
          previewSizes[kind],
          status && "flex items-center justify-center gap-2 px-3 text-muted-foreground",
          status && kind === "image" && "min-h-28"
        )}
      >
        {status ? (
          <>
            <Spinner
              aria-hidden="true"
              aria-label={undefined}
              role="presentation"
              className="size-3.5 shrink-0 motion-reduce:animate-none"
            />
            {status}
          </>
        ) : (
          children
        )}
      </div>
    </CardContent>
  )
}

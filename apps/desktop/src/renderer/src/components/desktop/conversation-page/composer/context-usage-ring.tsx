import { forwardRef, type ComponentProps } from "react"

import { Button } from "@renderer/components/ui/button"
import { cn } from "@renderer/lib/utils"
import type { DesktopContextUsageSnapshot } from "@shared/context-usage-types"

import {
  CONTEXT_BUCKET_COLORS,
  formatContextPercentLabel,
  nonEmptyBuckets,
} from "./context-usage-format"

export const ContextUsageRing = forwardRef<
  HTMLButtonElement,
  ComponentProps<typeof Button> & {
    snapshot: DesktopContextUsageSnapshot | null
  }
>(function ContextUsageRing({ snapshot, className, ...buttonProps }, ref) {
  const percentFull = snapshot?.percentFull ?? null
  const overflow = percentFull != null && percentFull > 1
  const percentLabel = formatContextPercentLabel(percentFull)
  const fill = percentFull == null ? 0 : Math.min(Math.max(percentFull, 0), 1)
  const size = 16
  const stroke = 2
  const radius = (size - stroke) / 2
  const circumference = 2 * Math.PI * radius
  const segments = snapshot ? nonEmptyBuckets(snapshot) : []
  const total = segments.reduce((sum, bucket) => sum + bucket.tokens, 0)

  let offset = 0
  const arcs =
    total > 0
      ? segments.map((bucket) => {
          const share = bucket.tokens / total
          const arcLength = circumference * share * (percentFull == null ? 1 : fill)
          const node = (
            <circle
              key={bucket.id}
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              stroke={CONTEXT_BUCKET_COLORS[bucket.id]}
              strokeWidth={stroke}
              strokeLinecap="round"
              strokeDasharray={`${arcLength} ${Math.max(circumference - arcLength, 0)}`}
              strokeDashoffset={-offset}
              transform={`rotate(-90 ${size / 2} ${size / 2})`}
            />
          )
          offset += arcLength
          return node
        })
      : null

  const aria = percentLabel != null ? `上下文占用 ${percentLabel}` : "上下文占用"

  return (
    <Button
      ref={ref}
      type="button"
      variant="ghost"
      size="icon"
      aria-label={aria}
      title={aria}
      {...buttonProps}
      className={cn(
        "text-muted-foreground",
        overflow && "text-destructive hover:text-destructive",
        className
      )}
    >
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        aria-hidden
        className="size-4 shrink-0"
      >
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeOpacity={0.22}
          strokeWidth={stroke}
        />
        {arcs}
      </svg>
    </Button>
  )
})

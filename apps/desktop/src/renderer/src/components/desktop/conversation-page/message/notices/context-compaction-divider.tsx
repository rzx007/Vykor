import { Check, CircleSlash, LoaderCircle, TriangleAlert } from "lucide-react"

import {
  compactionDividerLabel,
  type ContextCompactionPresentation,
} from "./compaction-presentation"

export function ContextCompactionDivider({
  presentation,
}: {
  presentation: ContextCompactionPresentation
}) {
  const label = compactionDividerLabel(presentation.phase)
  const Icon =
    presentation.phase === "started"
      ? LoaderCircle
      : presentation.phase === "completed"
        ? Check
        : presentation.phase === "failed"
          ? TriangleAlert
          : CircleSlash
  return (
    <div
      role="separator"
      aria-label={label}
      className="flex items-center gap-2 py-2 text-xs text-ui-muted"
    >
      <span className="h-px flex-1 bg-border/60" />
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
        <Icon className={presentation.phase === "started" ? "size-3.5 animate-spin" : "size-3.5"} />
        {label}
      </span>
      <span className="h-px flex-1 bg-border/60" />
    </div>
  )
}

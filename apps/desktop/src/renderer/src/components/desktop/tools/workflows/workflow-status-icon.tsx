import {
  Circle,
  CircleCheck,
  CircleDot,
  CircleHelp,
  CircleMinus,
  CircleStop,
  CircleX,
} from "lucide-react"
import type { DesktopWorkflowTaskStatus } from "@shared/workflow-types"
import { cn } from "@renderer/lib/utils"

export function WorkflowStatusIcon({
  status,
  className,
}: {
  status: DesktopWorkflowTaskStatus
  className?: string
}) {
  const Icon = {
    pending: Circle,
    running: CircleDot,
    completed: CircleCheck,
    failed: CircleX,
    skipped: CircleMinus,
    killed: CircleStop,
    unknown: CircleHelp,
  }[status]
  return (
    <Icon
      aria-hidden="true"
      strokeWidth={1.75}
      className={cn(
        "size-4 shrink-0",
        status === "failed"
          ? "text-destructive"
          : status === "running"
            ? "text-primary"
            : "text-muted-foreground",
        className
      )}
    />
  )
}

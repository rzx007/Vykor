import type { ReactNode } from "react"
import { CircleCheck, CircleAlert, CircleHelp, TriangleAlert } from "lucide-react"
import { cn } from "@renderer/lib/utils"

export type SettingsStatusTone = "success" | "warning" | "error" | "neutral"
const status = {
  success: { icon: CircleCheck, className: "text-status-success" },
  warning: { icon: TriangleAlert, className: "text-status-warning" },
  error: { icon: CircleAlert, className: "text-destructive" },
  neutral: { icon: CircleHelp, className: "text-muted-foreground" },
}
export function SettingsStatus({
  tone,
  children,
}: {
  tone: SettingsStatusTone
  children: ReactNode
}) {
  const { icon: Icon, className } = status[tone]
  return (
    <span
      className={cn("inline-flex shrink-0 items-center gap-1.5 text-sm font-medium", className)}
    >
      <Icon aria-hidden="true" className="size-4" strokeWidth={1.75} />
      {children}
    </span>
  )
}

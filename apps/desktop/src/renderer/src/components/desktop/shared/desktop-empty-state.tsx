import type { LucideIcon } from "lucide-react"

import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@renderer/components/ui/empty"
import { cn } from "@renderer/lib/utils"

export function DesktopEmptyState({
  icon: Icon,
  title,
  description,
  size = "default",
  className,
}: {
  icon: LucideIcon
  title: string
  description?: string
  size?: "sm" | "default"
  className?: string
}): React.JSX.Element {
  return (
    <Empty className={cn("h-full rounded-none border-0 p-8", className)}>
      <EmptyHeader>
        <EmptyMedia>
          <Icon
            className={cn("text-muted-foreground", size === "sm" ? "size-8" : "size-9")}
            strokeWidth={1.6}
          />
        </EmptyMedia>
        <EmptyTitle
          className={cn("font-semibold tracking-normal", size === "sm" ? "text-base" : "text-lg")}
        >
          {title}
        </EmptyTitle>
        {description ? (
          <EmptyDescription className="text-ui-small max-w-72 leading-6">
            {description}
          </EmptyDescription>
        ) : null}
      </EmptyHeader>
    </Empty>
  )
}

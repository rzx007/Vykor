import { ChevronDown, SquarePen } from "lucide-react"
import type * as React from "react"
import { Spinner } from "@renderer/components/ui/spinner"
import { cn } from "@renderer/lib/utils"

export function SidebarNavigationButton({
  icon: Icon,
  label,
  selected = false,
  badge = 0,
  running = false,
  onClick,
}: {
  icon: typeof SquarePen
  label: string
  selected?: boolean
  badge?: number
  running?: boolean
  onClick?: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={[label, running && "正在运行", badge > 0 && `${badge} 个结果待查看`]
        .filter(Boolean)
        .join("，")}
      className={cn(
        "flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-sm font-[450] text-sidebar-foreground transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
        selected && "bg-sidebar-selected"
      )}
    >
      <Icon className="size-4 text-sidebar-muted" strokeWidth={1.8} />
      <span>{label}</span>
      {running || badge > 0 ? (
        <span
          aria-hidden="true"
          className="ml-auto inline-flex shrink-0 items-center gap-1.5 text-sidebar-muted"
        >
          {running ? <Spinner className="size-3.5 motion-reduce:animate-none" /> : null}
          {badge > 0 ? (
            <span
              data-slot="navigation-badge"
              className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-sidebar-accent px-1 text-xs leading-none tabular-nums"
            >
              {badge}
            </span>
          ) : null}
        </span>
      ) : null}
    </button>
  )
}
export function SidebarSectionHeader({
  title,
  expanded,
  onToggle,
  actionLabel,
  onAction,
  className,
  running = false,
}: {
  title: string
  expanded: boolean
  onToggle: () => void
  actionLabel?: string
  onAction?: () => void
  className?: string
  running?: boolean
}): React.JSX.Element {
  return (
    <div className={cn("group/section flex h-7 w-full items-center px-2.5", className)}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left text-sm font-normal text-sidebar-muted/70 select-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <span>{title}</span>
        {!expanded && running ? (
          <Spinner
            role="img"
            aria-label={`${title}，有会话正在运行`}
            className="ml-auto size-3 motion-reduce:animate-none"
          />
        ) : null}
        <ChevronDown
          className={cn(
            "size-3.5 shrink-0 text-sidebar-muted/50 opacity-0 transition-all duration-200 group-hover/section:opacity-100 group-focus-visible/section:opacity-100",
            !expanded && "-rotate-90"
          )}
        />
      </button>
      {onAction ? (
        <button
          type="button"
          aria-label={actionLabel}
          title={actionLabel}
          onClick={onAction}
          className="grid size-6 place-items-center rounded text-sidebar-muted opacity-0 transition-opacity group-hover/section:opacity-100 hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring"
        >
          <SquarePen className="size-3.5" />
        </button>
      ) : null}
    </div>
  )
}

export function SidebarSectionLabel({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <div className={cn("px-2.5 pb-1.5 text-sm font-normal text-sidebar-muted/70", className)}>
      {children}
    </div>
  )
}

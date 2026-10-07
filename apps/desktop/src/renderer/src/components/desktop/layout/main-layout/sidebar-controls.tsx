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
      aria-label={
        badge ? `${label}，${badge} 个结果待查看` : running ? `${label}，正在运行` : label
      }
      className={cn(
        "text-ui-small flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-left font-[450] text-sidebar-foreground transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
        selected && "bg-sidebar-selected"
      )}
    >
      <Icon className="size-4 text-sidebar-muted" strokeWidth={1.8} />
      <span>{label}</span>
      {running ? (
        <Spinner aria-hidden="true" className="ml-auto size-3 motion-reduce:animate-none" />
      ) : null}
      {badge ? (
        <span
          aria-hidden="true"
          className="ml-auto rounded-full bg-sidebar-accent px-1.5 text-xs tabular-nums"
        >
          {badge}
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
  summary,
  running = false,
}: {
  title: string
  expanded: boolean
  onToggle: () => void
  actionLabel?: string
  onAction?: () => void
  className?: string
  summary?: React.ReactNode
  running?: boolean
}): React.JSX.Element {
  return (
    <div className={cn("group/section flex h-7 w-full items-center px-2.5", className)}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="text-ui-small flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left font-normal text-sidebar-muted/70 select-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <span>{title}</span>
        {!expanded && running ? (
          <Spinner
            role="img"
            aria-label={`${title}，有会话正在运行`}
            className="ml-auto size-3 motion-reduce:animate-none"
          />
        ) : null}
        {!expanded && summary !== undefined && summary !== null ? (
          <span
            className={cn(
              "text-xs tabular-nums text-sidebar-muted/70",
              !running && "ml-auto"
            )}
          >
            {summary}
          </span>
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
          className="grid size-6 place-items-center rounded text-sidebar-muted opacity-0 transition-opacity hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring group-hover/section:opacity-100"
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
    <div className={cn("text-ui-small px-2.5 pb-1.5 font-normal text-sidebar-muted/70", className)}>
      {children}
    </div>
  )
}

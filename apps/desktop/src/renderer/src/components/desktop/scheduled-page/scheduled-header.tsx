import { Bot, ChevronDown, PenLine, RefreshCw, Search } from "lucide-react"

import { Button } from "@renderer/components/ui/button"
import { ButtonGroup } from "@renderer/components/ui/button-group"
import { Input } from "@renderer/components/ui/input"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu"
import { cn } from "@renderer/lib/utils"
import type { DesktopScheduledStatus } from "@shared/schedule-types"
import { scheduledFilters, type ScheduledFilter } from "./types"
import { filterTabLabel } from "./utils"

export function ScheduledHeader({
  compact,
  filter,
  filterCounts,
  search,
  status,
  onFilterChange,
  onSearchChange,
  onRefresh,
  onCreateManual,
  onStartConversation,
  loading,
}: {
  compact: boolean
  filter: ScheduledFilter
  filterCounts: Record<ScheduledFilter, number>
  search: string
  status: DesktopScheduledStatus | null
  onFilterChange: (value: ScheduledFilter) => void
  onSearchChange: (value: string) => void
  onRefresh: () => Promise<void>
  onCreateManual: () => void
  onStartConversation: () => void
  loading: boolean
}): React.JSX.Element {
  return (
    <>
      <div
        className={cn(
          "flex items-start justify-between gap-4",
          !compact && "text-sidebar-foreground"
        )}
      >
        <div className={cn("min-w-0", !compact && "w-full max-w-136")}>
          <h1
            className={cn(
              "leading-tight font-normal tracking-[-0.015em] text-foreground",
              compact ? "text-[1.25rem]" : "mt-6 text-[1.75rem]"
            )}
          >
            已安排的任务
          </h1>
          <p
            className={cn(
              "text-muted-foreground",
              compact ? "text-ui-small mt-0.5" : "mt-2 text-base leading-6"
            )}
          >
            让 ChatGPT 安排任务、设置提醒或监测更新。
          </p>
        </div>

        <div className={cn("flex shrink-0 items-center gap-3", !compact && "pt-1")}>
          <Button
            variant="ghost"
            size="icon-sm"
            title="刷新任务"
            onClick={() => void onRefresh()}
            disabled={loading}
            className="size-9 rounded-full text-muted-foreground"
          >
            <RefreshCw className={cn("size-4", loading && "animate-spin")} />
          </Button>
          <ButtonGroup className="overflow-hidden rounded-full">
            <Button onClick={onStartConversation}>创建</Button>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={<Button size="icon" title="更多创建方式" />}
                aria-label="更多创建方式"
              >
                <ChevronDown data-icon="inline-end" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" sideOffset={6} className="min-w-44">
                <DropdownMenuGroup>
                  <DropdownMenuItem onClick={onCreateManual}>
                    <PenLine />
                    手动创建
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={onStartConversation}>
                    <Bot />
                    在对话中安排
                  </DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </ButtonGroup>
        </div>
      </div>

      <div className={cn("space-y-3", compact ? "mt-5" : "mt-7")}>
        <FilterTabs filter={filter} counts={filterCounts} onChange={onFilterChange} />
        <SearchBar
          value={search}
          placeholder="搜索已安排任务"
          onChange={onSearchChange}
          className="h-10 rounded-xl"
        />
      </div>

      {status?.unread ? (
        <div className="mt-4 text-xs text-muted-foreground">
          <span className="rounded-full bg-muted px-2 py-1 font-medium text-foreground">
            {status.unread}
          </span>
          <span className="ml-2">个结果待查看</span>
        </div>
      ) : null}
    </>
  )
}

function FilterTabs({
  filter,
  counts,
  onChange,
}: {
  filter: ScheduledFilter
  counts: Record<ScheduledFilter, number>
  onChange: (value: ScheduledFilter) => void
}): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-1" aria-label="任务筛选">
      {scheduledFilters.map((value) => (
        <button
          key={value}
          type="button"
          onClick={() => onChange(value)}
          aria-pressed={filter === value}
          className={cn(
            "text-ui-small inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
            filter === value
              ? "bg-muted font-medium text-foreground"
              : "text-muted-foreground hover:bg-muted/55 hover:text-foreground"
          )}
        >
          <span>{filterTabLabel(value)}</span>
          <span className="text-ui-caption text-muted-foreground tabular-nums">
            {counts[value]}
          </span>
        </button>
      ))}
    </div>
  )
}

function SearchBar({
  value,
  placeholder,
  onChange,
  className,
}: {
  value: string
  placeholder: string
  onChange: (value: string) => void
  className?: string
}): React.JSX.Element {
  return (
    <div className="relative">
      <Search
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
      />
      <Input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label="搜索任务"
        className={cn(
          "text-ui-small border-border/70 bg-background pl-10 shadow-none placeholder:text-muted-foreground",
          className
        )}
      />
    </div>
  )
}

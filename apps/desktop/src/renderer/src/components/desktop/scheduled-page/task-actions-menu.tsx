import { CirclePause, CirclePlay, MoreHorizontal, Pencil, Play, Trash2 } from "lucide-react"

import { Button } from "@renderer/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu"
import { cn } from "@renderer/lib/utils"
import type { DesktopScheduledTask } from "@shared/schedule-types"

export function TaskActionsMenu({
  task,
  busy,
  onRunNow,
  onEdit,
  onToggle,
  onDelete,
  triggerClassName,
}: {
  task: DesktopScheduledTask
  busy: boolean
  onRunNow: () => void
  onEdit: () => void
  onToggle?: () => void
  onDelete: () => void
  triggerClassName?: string
}): React.JSX.Element {
  const canToggle = task.status !== "completed" && Boolean(onToggle)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="ghost" size="icon" shape="circle" />}
        aria-label={`${task.name}的更多操作`}
        title="更多操作"
        className={cn("text-muted-foreground", triggerClassName)}
      >
        <MoreHorizontal />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={6} className="min-w-40">
        <DropdownMenuGroup>
          <DropdownMenuItem onClick={onEdit} disabled={busy}>
            <Pencil />
            编辑
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onRunNow} disabled={busy}>
            <Play />
            立即运行
          </DropdownMenuItem>
          {canToggle ? (
            <DropdownMenuItem onClick={onToggle} disabled={busy}>
              {task.status === "active" ? <CirclePause /> : <CirclePlay />}
              {task.status === "active" ? "暂停" : "继续"}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem variant="destructive" onClick={onDelete} disabled={busy}>
            <Trash2 />
            删除
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

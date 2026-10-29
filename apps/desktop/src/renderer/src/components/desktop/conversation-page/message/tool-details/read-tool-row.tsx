import { BookOpen, ChevronDown } from "lucide-react"
import type { DesktopSessionPart } from "@shared/session-types"
import { Button } from "@renderer/components/ui/button"
import { cn } from "@renderer/lib/utils"
import { toolActivityLabel, toolCallStatus } from "../models/message-render-model"

export function ReadToolRow({
  call,
  result,
  file,
  active,
  calling,
  onToggle,
  onOpenFile,
}: {
  call: DesktopSessionPart
  result?: DesktopSessionPart
  file: { path: string; line?: number }
  active: boolean
  calling: boolean
  onToggle: () => void
  onOpenFile: (path: string, line?: number) => void
}) {
  const status = toolCallStatus(call, result)
  const activity = calling ? toolActivityLabel(call, result) : undefined
  const name = file.path.split(/[\\/]/).pop() || file.path
  const label =
    status === "completed"
      ? "已读取"
      : status === "failed"
        ? "读取失败"
        : status === "interrupted"
          ? "读取已中断"
          : "读取文件"
  return (
    <div
      className={cn(
        "group/read-tool flex min-h-7 min-w-0 items-center gap-2",
        calling && "shimmer"
      )}
    >
      <BookOpen className="size-3.5 shrink-0" strokeWidth={1.75} />
      <span className="shrink-0">{label}</span>
      <button
        type="button"
        title={file.path}
        onClick={() => onOpenFile(file.path, file.line)}
        className="min-w-0 truncate underline decoration-ui-muted/40 underline-offset-2 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        {name}
      </button>
      {activity ? <span className="shrink-0 text-ui-muted">{activity}</span> : null}
      <Button
        variant="ghost"
        size="icon-sm"
        shape="circle"
        aria-label="查看读取结果"
        title="查看读取结果"
        aria-expanded={active}
        onClick={onToggle}
        className="opacity-0 transition-opacity group-focus-within/read-tool:opacity-100 group-hover/read-tool:opacity-100 motion-reduce:transition-none"
      >
        <ChevronDown
          aria-hidden="true"
          className={cn("size-3.5 motion-safe:transition-transform", active && "rotate-180")}
        />
      </Button>
    </div>
  )
}

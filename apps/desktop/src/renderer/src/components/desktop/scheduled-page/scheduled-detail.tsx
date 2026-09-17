import {
  Archive,
  Circle,
  CirclePause,
  CirclePlay,
  History,
  MoreHorizontal,
  Play,
  X,
} from "lucide-react"

import { Button } from "@renderer/components/ui/button"
import { ScrollArea } from "@renderer/components/ui/scroll-area"
import { Spinner } from "@renderer/components/ui/spinner"
import { cn } from "@renderer/lib/utils"
import type { DesktopScheduledRun, DesktopScheduledTask } from "@shared/schedule-types"
import { TaskActionsMenu } from "./task-actions-menu"
import {
  formatRunAge,
  projectLabel,
  recurrenceFrequency,
  recurrenceTime,
  runHistoryState,
  statusLabel,
} from "./utils"

export function DetailPanel({
  task,
  runs,
  busy,
  onBack,
  onRunNow,
  onEdit,
  onToggle,
  onDelete,
  onOpenSession,
}: {
  task: DesktopScheduledTask
  runs: DesktopScheduledRun[]
  busy: string | null
  onBack: () => void
  onRunNow: () => void
  onEdit: () => void
  onToggle: () => void
  onDelete: () => void
  onOpenSession: (sessionId: string) => void
}): React.JSX.Element {
  const isRunning = busy === "run" || busy === `run:${task.id}`
  const canToggle = task.status !== "completed"

  return (
    <div className="mx-auto w-full">
      <div className="flex items-center justify-between gap-4">
        <span className="text-ui-small font-medium text-blue-600 dark:text-blue-400">
          {statusLabel(task.status)}
        </span>
        <div className="flex items-center gap-1.5">
          <Button
            variant="outline"
            size="sm"
            onClick={onRunNow}
            disabled={busy !== null}
            title="立即运行任务"
            className="h-8 gap-1.5 rounded-lg px-2.5 text-xs font-medium"
          >
            {isRunning ? (
              <Spinner className="size-3.5" />
            ) : (
              <Play className="size-3.5 fill-current" />
            )}
            <span>立即运行</span>
          </Button>
          {canToggle ? (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={onToggle}
              disabled={busy !== null}
              title={task.status === "active" ? "暂停任务" : "继续任务"}
              aria-label={task.status === "active" ? "暂停任务" : "继续任务"}
              className="size-8 rounded-lg text-muted-foreground hover:text-foreground"
            >
              {busy === "toggle" ? (
                <Spinner className="size-3.5" />
              ) : task.status === "active" ? (
                <CirclePause className="size-4" />
              ) : (
                <CirclePlay className="size-4" />
              )}
            </Button>
          ) : null}
          <TaskActionsMenu
            task={task}
            busy={busy !== null}
            onRunNow={onRunNow}
            onEdit={onEdit}
            onToggle={canToggle ? onToggle : undefined}
            onDelete={onDelete}
          />
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onBack}
            title="关闭详情"
            aria-label="关闭详情"
            className="size-8 rounded-lg text-muted-foreground hover:text-foreground"
          >
            <X className="size-4" />
          </Button>
        </div>
      </div>

      <h2 className="mt-3 truncate text-base font-medium tracking-[-0.01em] text-foreground">
        {task.name}
      </h2>

      <ScrollArea
        className="mt-7 max-h-64.5 rounded-2xl border border-border/70 bg-muted/10"
        viewportClassName="px-4 py-4"
      >
        <div className="text-ui-small max-w-[76ch] leading-6 whitespace-pre-wrap text-foreground/90">
          {task.prompt}
        </div>
      </ScrollArea>

      <SettingsGroup
        title="详情"
        className="mt-8"
        items={[
          {
            label: "运行于",
            value: task.destination === "chat" ? "现有聊天" : "每次独立对话",
          },
          {
            label: task.destination === "chat" ? "聊天" : "工作位置",
            value:
              task.destination === "chat"
                ? task.name
                : task.projectPaths[0]
                  ? projectLabel(task)
                  : "不在项目中工作",
          },
        ]}
      />

      <SettingsGroup
        title="频率"
        className="mt-8"
        items={[
          { label: "重复", value: recurrenceFrequency(task) },
          { label: "时间", value: recurrenceTime(task) ?? "按规则执行" },
          { label: "通知", value: "重要更新" },
        ]}
      />

      <section className="mt-12">
        <div className="flex items-center justify-between px-1">
          <h3 className="text-ui-small font-normal text-muted-foreground/70">运行历史记录</h3>
          <MoreHorizontal className="size-4 text-muted-foreground/65" aria-hidden="true" />
        </div>

        {runs.length === 0 ? (
          <div className="flex h-20 items-center gap-2 px-2 text-xs text-muted-foreground">
            <History className="size-4" />
            这个任务还没有运行记录
          </div>
        ) : (
          <div className="mt-3">
            {runs.slice(0, 4).map((run, index) => {
              const historyState = runHistoryState(run)
              return (
                <button
                  key={run.id}
                  type="button"
                  disabled={historyState !== "openable"}
                  onClick={() => run.sessionId && onOpenSession(run.sessionId)}
                  className={cn(
                    "flex min-h-10 w-full items-center gap-3 rounded-lg px-2 text-left text-xs text-muted-foreground",
                    historyState === "openable" && "hover:bg-muted/60 hover:text-foreground",
                    historyState !== "openable" && "cursor-default"
                  )}
                >
                  {index === 0 ? (
                    <Circle className="size-2.5 shrink-0 fill-current" strokeWidth={0} />
                  ) : (
                    <Archive className="size-3.5 shrink-0" strokeWidth={1.6} />
                  )}
                  <span className={cn("truncate", index === 0 && "font-medium text-foreground/80")}>
                    {task.name}
                  </span>
                  <span className="truncate text-muted-foreground/60">
                    {historyState === "pending"
                      ? "正在创建会话"
                      : historyState === "unavailable"
                        ? "会话已删除或不可用"
                        : projectLabel(task)}
                  </span>
                  <time
                    className="ml-auto shrink-0 text-muted-foreground/60 tabular-nums"
                    dateTime={new Date(run.createdAt).toISOString()}
                  >
                    {formatRunAge(run.createdAt)}
                  </time>
                </button>
              )
            })}
          </div>
        )}
      </section>
    </div>
  )
}

function SettingsGroup({
  title,
  items,
  className,
}: {
  title: string
  items: Array<{ label: string; value: string }>
  className?: string
}): React.JSX.Element {
  return (
    <section className={className}>
      <h3 className="text-ui-small px-1 font-normal text-muted-foreground/70">{title}</h3>
      <dl className="mt-3 overflow-hidden rounded-2xl border border-border/70 bg-background">
        {items.map((item) => (
          <div
            key={item.label}
            className="flex min-h-[50px] items-center justify-between gap-6 border-b border-border/60 px-4 last:border-b-0"
          >
            <dt className="text-ui-small text-foreground/80">{item.label}</dt>
            <dd className="text-ui-small min-w-0 truncate font-medium text-foreground">
              {item.value}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

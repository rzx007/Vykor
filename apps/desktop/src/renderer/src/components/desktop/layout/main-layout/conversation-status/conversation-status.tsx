import { useId, useMemo, useState } from "react"
import { CornerUpLeft, Square, X } from "lucide-react"
import { Button } from "@renderer/components/ui/button"
import { Spinner } from "@renderer/components/ui/spinner"
import { ElapsedTime } from "@renderer/components/desktop/conversation-page/message/task-duration"
import { useDesktopSessionStore } from "@renderer/stores/desktop-session"
import { cn } from "@renderer/lib/utils"
import { resolveConversationStatus } from "./conversation-status-model"

export function ConversationStatus({
  visible,
  onRestore,
}: {
  visible: boolean
  onRestore: () => void
}): React.JSX.Element | null {
  const sessionId = useDesktopSessionStore((state) => state.activeSessionId)
  const view = useDesktopSessionStore((state) => state.sessionView)
  const interrupt = useDesktopSessionStore((state) => state.interrupt)
  const stopping = useDesktopSessionStore((state) =>
    Boolean(
      state.activeSessionId &&
      Object.values(state.sessionRuntimes[state.activeSessionId]?.operations ?? {}).some(
        (operation) => operation.kind === "interrupt-run" && operation.phase === "pending"
      )
    )
  )
  const [dismissedKey, setDismissedKey] = useState<string | null>(null)
  const descriptionId = useId()
  const status = useMemo(
    () => (visible ? resolveConversationStatus(view, sessionId) : null),
    [visible, view, sessionId]
  )
  if (!status || (status.dismissible && dismissedKey === status.key)) return null
  const attention = ["permission", "question", "failed"].includes(status.kind)
  const busy = status.kind === "processing" || status.kind === "reconnecting"
  const timingActive = status.timing?.status === "running" || status.timing?.status === "pending"

  return (
    <aside
      aria-label="当前会话状态"
      className="absolute right-4 bottom-4 z-20 flex w-[min(28rem,calc(100%-2rem))] animate-in items-center gap-1 rounded-xl border border-border/60 bg-popover p-1 text-popover-foreground shadow-md duration-150 fade-in-0 motion-reduce:animate-none"
    >
      <Button
        type="button"
        variant="ghost"
        onClick={onRestore}
        aria-label="返回当前聊天"
        aria-describedby={descriptionId}
        title={`${view?.session.title ?? "当前聊天"}\n${status.summary}`}
        className="h-auto min-w-0 flex-1 justify-start px-3 py-2 text-left whitespace-normal"
      >
        <span id={descriptionId} className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-ui-caption flex items-center gap-2">
            {busy ? (
              <Spinner aria-hidden="true" className="motion-reduce:animate-none" />
            ) : (
              <span
                aria-hidden="true"
                className={cn(
                  "size-1.5 shrink-0 rounded-full",
                  attention ? "bg-amber-600" : "bg-muted-foreground/50"
                )}
              />
            )}
            <span aria-live="polite" aria-atomic="true">
              {status.label}
            </span>
            <ElapsedTime
              key={`${status.key}:${timingActive}`}
              startedAt={status.timing?.startedAt}
              finishedAt={status.timing?.finishedAt}
              running={timingActive}
              prefix={status.dismissible ? "耗时 " : ""}
            />
          </span>
          <span className="text-ui-caption truncate font-normal text-muted-foreground">
            {status.summary}
          </span>
        </span>
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="返回当前聊天分栏"
        title="返回聊天"
        onClick={onRestore}
      >
        <CornerUpLeft />
      </Button>
      {status.canStop ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="停止当前任务"
          title={stopping ? "正在停止" : "停止当前任务"}
          disabled={stopping}
          onClick={() => void interrupt()}
        >
          <Square />
        </Button>
      ) : null}
      {status.dismissible ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="关闭任务结果提示"
          title="关闭提示"
          onClick={() => setDismissedKey(status.key)}
        >
          <X />
        </Button>
      ) : null}
    </aside>
  )
}

import { Check, Copy, GitBranchPlus } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { Button } from "@renderer/components/ui/button"
import { Spinner } from "@renderer/components/ui/spinner"
import { cn } from "@renderer/lib/utils"
import type { DesktopSessionMessage } from "@shared/session-types"
import { formatMessageTime } from "./format-message-time"

export function AssistantMessageActions({
  message,
  content,
  disabled,
  onCopy,
  onFork,
}: {
  message?: DesktopSessionMessage
  content: string
  disabled: boolean
  onCopy: (content: string) => void | Promise<void>
  onFork?: (messageId: string) => void | Promise<void>
}): React.JSX.Element | null {
  if (!message) return null
  return (
    <MessageToolbar align="start" timestamp={message.updatedAt}>
      {content.trim() ? (
        <CopyActionButton
          key={`copy:${message.id}`}
          label="复制回复"
          copiedLabel="已复制"
          disabled={disabled}
          onCopy={() => onCopy(content)}
        />
      ) : null}
      {onFork ? (
        <FeedbackActionButton
          key={`fork:${message.id}`}
          label="从这条回复分叉"
          pendingLabel="正在创建分叉"
          completedLabel="已创建分叉"
          failureLabel="创建分叉失败，请重试。"
          onAction={() => onFork(message.id)}
          disabled={disabled}
        >
          <GitBranchPlus />
        </FeedbackActionButton>
      ) : null}
    </MessageToolbar>
  )
}

export function MessageToolbar({
  align,
  timestamp,
  children,
}: {
  align: "start" | "end"
  timestamp: number
  children?: React.ReactNode
}): React.JSX.Element {
  const label = formatMessageTime(timestamp)
  const absolute = new Date(timestamp).toLocaleString()
  const time = (
    <time dateTime={new Date(timestamp).toISOString()} title={absolute} className="ml-0.5 shrink-0">
      {label}
    </time>
  )

  return (
    <div
      className={cn(
        "mt-1.5 flex min-h-7 flex-wrap items-center gap-0.5 text-xs text-ui-muted",
        "pointer-events-none opacity-0 transition-opacity",
        "group-hover/msg:pointer-events-auto group-hover/msg:opacity-100",
        "group-focus-within/msg:pointer-events-auto group-focus-within/msg:opacity-100",
        "has-[[aria-busy=true]]:pointer-events-auto has-[[aria-busy=true]]:opacity-100",
        "has-[[role=alert]]:pointer-events-auto has-[[role=alert]]:opacity-100",
        "has-[[role=status]]:pointer-events-auto has-[[role=status]]:opacity-100",
        align === "end" ? "justify-end" : "justify-start"
      )}
    >
      {children}
      {time}
    </div>
  )
}

export function MessageActionButton({
  label,
  onClick,
  disabled,
  busy,
  children,
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  busy?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <Button
      type="button"
      variant="ghost"
      shape="circle"
      size="icon-sm"
      title={label}
      aria-label={label}
      disabled={disabled}
      aria-busy={busy || undefined}
      onClick={onClick}
      className="text-muted-foreground"
    >
      {children}
    </Button>
  )
}

export function CopyActionButton({
  label,
  copiedLabel,
  disabled,
  onCopy,
}: {
  label: string
  copiedLabel: string
  disabled?: boolean
  onCopy: () => void | Promise<void>
}): React.JSX.Element {
  return (
    <FeedbackActionButton
      label={label}
      pendingLabel={`正在${label}`}
      completedLabel={copiedLabel}
      failureLabel="复制失败，请重试。"
      disabled={disabled}
      onAction={onCopy}
    >
      <Copy />
    </FeedbackActionButton>
  )
}

/** 两种消息操作共用反馈；只保存按钮状态，不持有消息或请求副本。 */
function FeedbackActionButton({
  label,
  pendingLabel,
  completedLabel,
  failureLabel,
  disabled,
  onAction,
  children,
}: {
  label: string
  pendingLabel: string
  completedLabel: string
  failureLabel: string
  disabled?: boolean
  onAction: () => void | Promise<void>
  children: React.ReactNode
}) {
  const [status, setStatus] = useState<"idle" | "pending" | "completed" | "failed">("idle")
  const busy = useRef(false)
  const mounted = useRef(true)
  const timer = useRef<number | null>(null)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      if (timer.current !== null) window.clearTimeout(timer.current)
    }
  }, [])
  const run = async () => {
    if (disabled || busy.current || !mounted.current) return
    busy.current = true
    if (timer.current !== null) window.clearTimeout(timer.current)
    setStatus("pending")
    try {
      await onAction()
      if (!mounted.current) return
      setStatus("completed")
      timer.current = window.setTimeout(() => setStatus("idle"), 1400)
    } catch {
      if (mounted.current) setStatus("failed")
    } finally {
      busy.current = false
    }
  }
  return (
    <>
      <MessageActionButton
        label={
          status === "pending"
            ? pendingLabel
            : status === "completed"
              ? completedLabel
              : status === "failed"
                ? `重试${label}`
                : label
        }
        onClick={() => void run()}
        disabled={disabled || status === "pending"}
        busy={status === "pending"}
      >
        {status === "pending" ? <Spinner /> : status === "completed" ? <Check /> : children}
      </MessageActionButton>
      {status === "failed" ? (
        <span role="alert" className="text-xs text-destructive">
          {failureLabel}
        </span>
      ) : null}
      {status === "completed" ? (
        <span role="status" className="sr-only">
          {completedLabel}
        </span>
      ) : null}
    </>
  )
}

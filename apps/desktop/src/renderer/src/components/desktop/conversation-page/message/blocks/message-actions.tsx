import { Check, Copy, GitBranchPlus } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { Button } from "@renderer/components/ui/button"
import { Spinner } from "@renderer/components/ui/spinner"
import { toast } from "@renderer/lib/toast"
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
  onFork?: (messageId: string) => void
}): React.JSX.Element | null {
  if (!message) return null
  return (
    <MessageToolbar align="start" timestamp={message.updatedAt}>
      {content.trim() ? (
        <CopyActionButton
          key={message.id}
          label="复制回复"
          copiedLabel="已复制"
          disabled={disabled}
          onCopy={() => onCopy(content)}
        />
      ) : null}
      {onFork ? (
        <MessageActionButton
          label="从这条回复分叉"
          onClick={() => onFork(message.id)}
          disabled={disabled}
        >
          <GitBranchPlus />
        </MessageActionButton>
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
        "mt-1.5 flex h-7 items-center gap-0.5 text-xs text-ui-muted",
        "pointer-events-none opacity-0 transition-opacity",
        "group-hover/msg:pointer-events-auto group-hover/msg:opacity-100",
        "group-focus-within/msg:pointer-events-auto group-focus-within/msg:opacity-100",
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
  busy = false,
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
      className="text-muted-foreground [&_svg]:size-3.5"
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
  const [copied, setCopied] = useState(false)
  const [copying, setCopying] = useState(false)
  const busy = useRef(false)
  const timer = useRef<number | null>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      if (timer.current !== null) window.clearTimeout(timer.current)
    }
  }, [])
  const handleCopy = async (): Promise<void> => {
    if (disabled || busy.current) return
    busy.current = true
    if (timer.current !== null) window.clearTimeout(timer.current)
    setCopying(true)
    setCopied(false)
    try {
      await onCopy()
      toast.success(copiedLabel)
      if (mounted.current) {
        setCopied(true)
        timer.current = window.setTimeout(() => setCopied(false), 1400)
      }
    } catch {
      toast.error("复制失败", "请重试。")
    } finally {
      busy.current = false
      if (mounted.current) setCopying(false)
    }
  }
  return (
    <MessageActionButton
      label={copying ? "正在复制" : copied ? copiedLabel : label}
      onClick={() => void handleCopy()}
      disabled={disabled || copying}
      busy={copying}
    >
      {copying ? <Spinner /> : copied ? <Check /> : <Copy />}
    </MessageActionButton>
  )
}

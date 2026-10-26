import { Check, Copy, GitBranchPlus } from "lucide-react"
import { useState } from "react"
import { Button } from "@renderer/components/ui/button"
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
  children,
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="text-muted-foreground/50 hover:text-muted-foreground"
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
  const handleCopy = async (): Promise<void> => {
    try {
      await onCopy()
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1400)
    } catch {
      setCopied(false)
    }
  }
  return (
    <MessageActionButton
      label={copied ? copiedLabel : label}
      onClick={() => void handleCopy()}
      disabled={disabled}
    >
      {copied ? <Check /> : <Copy />}
    </MessageActionButton>
  )
}

import type { ConversationSearchMatch } from "../../transcript/conversation-find-model"
import { Box, ChevronDown, ChevronUp } from "lucide-react"
import { useState } from "react"
import { cn } from "@renderer/lib/utils"
import { PluginMentionIcon } from "./plugin-mention-icon"
import type { UserDisplayItem } from "./user-display-items"

const collapsibleUserMessageChars = 900
const collapsibleUserMessageLines = 14

export function UserMessageBubble({
  content,
  items,
  annotated = false,
  searchReveal = null,
  searchSource,
}: {
  content: string
  searchReveal?: ConversationSearchMatch | null
  searchSource?: { messageId: string; partIds: string[] }
  items: UserDisplayItem[]
  annotated?: boolean
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(() => Boolean(searchReveal))
  const [previousReveal, setPreviousReveal] = useState(searchReveal)
  if (searchReveal !== previousReveal) {
    setPreviousReveal(searchReveal)
    if (searchReveal) setExpanded(true)
  }
  const longEnough =
    content.length > collapsibleUserMessageChars ||
    content.split("\n").length > collapsibleUserMessageLines
  const collapsed = longEnough && !expanded

  return (
    <div
      className={cn(
        "text-chat max-w-[78%] overflow-hidden",
        annotated
          ? "rounded-2xl bg-foreground text-background"
          : "rounded-xl bg-user-message-bubble text-sidebar-foreground"
      )}
    >
      <div className="relative">
        <div
          data-chat-search-text
          data-chat-search-message={searchSource?.messageId}
          data-chat-search-parts={JSON.stringify(searchSource?.partIds ?? [])}
          className={cn(
            "px-4 whitespace-pre-wrap",
            annotated ? "py-2.5" : "py-3",
            collapsed && "max-h-72 overflow-hidden"
          )}
        >
          {items.length > 0
            ? items.map((item, index) =>
                item.kind === "text" ? (
                  <span key={index}>{item.text}</span>
                ) : (
                  <span
                    key={index}
                    className={cn(
                      "align-baseline select-none",
                      annotated ? "!text-background" : "!text-primary",
                      item.kind === "plugin" ? "font-semibold" : "font-medium"
                    )}
                  >
                    {item.kind === "plugin" ? (
                      <PluginMentionIcon pluginId={item.name} />
                    ) : (
                      <Box className="mr-1 inline-block size-3.5 align-middle" />
                    )}
                    <span>{item.displayName}</span>
                  </span>
                )
              )
            : content}
        </div>
        {collapsed ? (
          <div
            className={cn(
              "pointer-events-none absolute right-0 bottom-0 left-0 h-16 bg-linear-to-b",
              annotated
                ? "from-foreground/0 to-foreground"
                : "from-user-message-bubble/0 to-user-message-bubble"
            )}
          />
        ) : null}
      </div>
      {longEnough ? (
        <button
          type="button"
          aria-expanded={!collapsed}
          onClick={() => setExpanded((value) => !value)}
          className={cn(
            "flex h-9 w-full items-center justify-start gap-1 px-4 text-xs font-medium transition-colors motion-reduce:transition-none",
            annotated
              ? "bg-foreground text-background/80 hover:text-background"
              : "bg-user-message-bubble/55 text-muted-foreground hover:bg-user-message-bubble/75 hover:text-foreground"
          )}
        >
          <span>{!collapsed ? "收起" : "显示更多"}</span>
          {expanded ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
        </button>
      ) : null}
    </div>
  )
}

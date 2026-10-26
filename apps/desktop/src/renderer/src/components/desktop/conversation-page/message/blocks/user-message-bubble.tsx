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
}: {
  content: string
  items: UserDisplayItem[]
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const longEnough =
    content.length > collapsibleUserMessageChars ||
    content.split("\n").length > collapsibleUserMessageLines
  const collapsed = longEnough && !expanded

  return (
    <div className="text-chat max-w-[78%] overflow-hidden rounded-xl bg-user-message-bubble text-sidebar-foreground">
      <div className="relative">
        <div
          className={cn("px-4 py-3 whitespace-pre-wrap", collapsed && "max-h-72 overflow-hidden")}
        >
          {items.length > 0
            ? items.map((item, index) =>
                item.kind === "text" ? (
                  <span key={index}>{item.text}</span>
                ) : (
                  <span
                    key={index}
                    className={cn(
                      "align-baseline !text-primary select-none",
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
          <div className="pointer-events-none absolute right-0 bottom-0 left-0 h-16 bg-linear-to-b from-user-message-bubble/0 to-user-message-bubble" />
        ) : null}
      </div>
      {longEnough ? (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          className="flex h-9 w-full items-center justify-start gap-1 bg-user-message-bubble/55 px-4 text-xs font-medium text-muted-foreground transition-colors hover:bg-user-message-bubble/75 hover:text-foreground motion-reduce:transition-none"
        >
          <span>{expanded ? "收起" : "显示更多"}</span>
          {expanded ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
        </button>
      ) : null}
    </div>
  )
}

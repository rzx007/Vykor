import type { ConversationRailItem } from "./conversation-rail-items"

export function ConversationRailPreview({
  item,
}: {
  item: ConversationRailItem
}): React.JSX.Element {
  return (
    <div
      data-slot="conversation-rail-preview"
      className="rounded-xl border border-border bg-card px-3 py-2.5 text-card-foreground shadow-md"
    >
      <p
        data-slot="conversation-rail-prompt"
        className="line-clamp-2 text-sm leading-6 font-medium"
      >
        {item.prompt}
      </p>
      {item.reply ? (
        <p
          data-slot="conversation-rail-reply"
          className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground"
        >
          {item.reply}
        </p>
      ) : null}
    </div>
  )
}

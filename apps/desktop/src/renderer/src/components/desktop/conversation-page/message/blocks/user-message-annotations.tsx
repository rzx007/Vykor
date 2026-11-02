import { MessageCircle } from "lucide-react"
import { Button } from "@renderer/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "@renderer/components/ui/popover"
import type { BrowserAnnotationContextRecord } from "@renderer/components/desktop/tools/browser/browser-annotation-context"

export function UserMessageAnnotations({
  annotations,
}: {
  annotations: readonly BrowserAnnotationContextRecord[]
}) {
  if (!annotations.length) return null
  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        closeDelay={150}
        render={
          <Button
            type="button"
            variant="outline"
            shape="pill"
            size="sm"
            className="mb-1.5 text-xs text-muted-foreground"
          />
        }
      >
        <MessageCircle data-icon="inline-start" />
        {annotations.length} 条批注
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        initialFocus={false}
        className="max-h-72 w-80 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-2xl p-3"
      >
        <PopoverTitle className="sr-only">消息批注（只读）</PopoverTitle>
        <ol className="flex flex-col gap-3 text-sm">
          {annotations.map((annotation, index) => (
            <li key={annotation.id ?? index} className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">{annotation.target}</span>
              <p className="break-words whitespace-pre-wrap">{annotation.comment}</p>
            </li>
          ))}
        </ol>
      </PopoverContent>
    </Popover>
  )
}

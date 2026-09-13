import { Goal, ListChecks, MessageSquare, Paperclip, Puzzle } from "lucide-react"
import { Fragment, useEffect, useMemo, useRef, useState } from "react"

import { Button } from "@renderer/components/ui/button"
import { cn } from "@renderer/lib/utils"

export interface ContextPickerItem {
  id: string
  label: string
  description: string
  group: string
  sourceLabel?: string
  action:
    | { kind: "files" }
    | { kind: "plan" }
    | { kind: "goal" }
    | { kind: "plugin"; pluginId: string; displayName: string }
    | { kind: "conversation"; sessionId: string; displayName: string }
}

export function ContextPicker({ items, query, onSelect, onDismiss }: {
  items: readonly ContextPickerItem[]
  query: string
  onSelect: (item: ContextPickerItem) => void
  onDismiss: () => void
}): React.JSX.Element {
  const normalized = query.trim().toLocaleLowerCase()
  const options = useMemo(
    () => items.filter((item) => !normalized || `${item.label} ${item.description}`.toLocaleLowerCase().includes(normalized)),
    [items, normalized],
  )
  const [highlightedIndex, setHighlightedIndex] = useState(0)
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([])
  const pickerRef = useRef<HTMLDivElement | null>(null)
  const activeIndex = Math.min(highlightedIndex, Math.max(options.length - 1, 0))

  useEffect(() => setHighlightedIndex(0), [query, options.length])
  useEffect(() => optionRefs.current[activeIndex]?.scrollIntoView?.({ block: "nearest" }), [activeIndex])
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault()
        onDismiss()
      } else if (options.length > 0 && event.key === "ArrowDown") {
        event.preventDefault()
        setHighlightedIndex((current) => (current + 1) % options.length)
      } else if (options.length > 0 && event.key === "ArrowUp") {
        event.preventDefault()
        setHighlightedIndex((current) => (current - 1 + options.length) % options.length)
      } else if (options.length > 0 && (event.key === "Enter" || event.key === "Tab")) {
        event.preventDefault()
        event.stopPropagation()
        onSelect(options[activeIndex]!)
      }
    }
    const handlePointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Element && event.target.closest('[data-context-picker-toggle]')) return
      if (event.target instanceof Node && !pickerRef.current?.contains(event.target)) onDismiss()
    }
    window.addEventListener("keydown", handleKeyDown, true)
    document.addEventListener("pointerdown", handlePointerDown, true)
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true)
      document.removeEventListener("pointerdown", handlePointerDown, true)
    }
  }, [activeIndex, onDismiss, onSelect, options])

  return (
    <div ref={pickerRef} role="listbox" aria-label="添加上下文" className="absolute right-0 bottom-[calc(100%+10px)] left-0 z-40 overflow-hidden rounded-2xl bg-background/95 py-2 shadow-composer ring-1 ring-black/7 backdrop-blur dark:bg-card/95 dark:ring-white/12">
      <div className="px-5 pt-1 pb-2 text-sm text-muted-foreground">添加</div>
      <div className="max-h-80 scrollbar-thin overflow-y-auto overscroll-contain px-3 pb-2">
        {options.length === 0 ? <p className="px-2 py-3 text-sm text-muted-foreground">没有匹配的上下文</p> : null}
        {options.map((item, index) => (
          <Fragment key={item.id}>
            {item.group !== "添加" && item.group !== options[index - 1]?.group ? (
              <div role="presentation" className="px-2 pt-3 pb-1 text-sm text-muted-foreground">{item.group}</div>
            ) : null}
            <Button
              ref={(element) => { optionRefs.current[index] = element }}
              type="button"
              variant="ghost"
              role="option"
              aria-selected={index === activeIndex}
              onMouseEnter={() => setHighlightedIndex(index)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onSelect(item)}
              className={cn("flex h-10 w-full justify-start gap-2 rounded-xl px-2 text-left font-normal", index === activeIndex && "bg-muted text-foreground")}
            >
              <span className="grid size-6 shrink-0 place-items-center text-muted-foreground">
                {item.action.kind === "plugin" ? <Puzzle className="size-4" /> : item.action.kind === "files" ? <Paperclip className="size-4" /> : item.action.kind === "plan" ? <ListChecks className="size-4" /> : item.action.kind === "goal" ? <Goal className="size-4" /> : <MessageSquare className="size-4" />}
              </span>
              <span className="min-w-0 truncate text-sm font-medium">{item.label}</span>
              <span className="min-w-0 truncate text-sm text-muted-foreground">{item.description}</span>
              {item.sourceLabel ? <span className="ml-auto shrink-0 text-sm text-muted-foreground/65">{item.sourceLabel}</span> : null}
            </Button>
          </Fragment>
        ))}
      </div>
    </div>
  )
}

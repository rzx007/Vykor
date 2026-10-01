import { Box, Command } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"

import { Button } from "@renderer/components/ui/button"
import { cn } from "@renderer/lib/utils"
import { filterPickerItems, type ComposerPickerItem } from "./composer-picker-model"
export type {
  ComposerPickerSkill,
  ComposerPickerCatalogSkill,
  ComposerPickerCommand,
  ComposerPickerItem,
} from "./composer-picker-model"

export function ComposerPicker({
  items,
  query,
  onSelect,
  onDismiss,
  label = "命令和技能",
}: {
  items: readonly ComposerPickerItem[]
  query: string
  onSelect: (item: ComposerPickerItem) => void
  onDismiss: () => void
  label?: string
}): React.JSX.Element | null {
  const options = useMemo(() => filterPickerItems(items, query), [items, query])
  const optionsKey = JSON.stringify([query, options.map((item) => item.id)])
  const [highlighted, setHighlighted] = useState({ key: optionsKey, index: 0 })
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([])
  const pickerRef = useRef<HTMLDivElement | null>(null)
  if (highlighted.key !== optionsKey) setHighlighted({ key: optionsKey, index: 0 })
  const activeIndex =
    highlighted.key === optionsKey
      ? Math.min(highlighted.index, Math.max(options.length - 1, 0))
      : 0

  useEffect(() => {
    optionRefs.current[activeIndex]?.scrollIntoView?.({ block: "nearest" })
  }, [activeIndex, optionsKey])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.isComposing || options.length === 0) return
      if (event.key === "ArrowDown") {
        event.preventDefault()
        setHighlighted((current) => ({
          key: optionsKey,
          index: (current.index + 1) % options.length,
        }))
      } else if (event.key === "ArrowUp") {
        event.preventDefault()
        setHighlighted((current) => ({
          key: optionsKey,
          index: (current.index - 1 + options.length) % options.length,
        }))
      } else if ((event.key === "Enter" || event.key === "Tab") && options.length > 0) {
        event.preventDefault()
        event.stopPropagation()
        onSelect(options[activeIndex]!)
      } else if (event.key === "Escape") {
        event.preventDefault()
        onDismiss()
      }
    }
    const handlePointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Node && !pickerRef.current?.contains(event.target)) onDismiss()
    }
    window.addEventListener("keydown", handleKeyDown, true)
    document.addEventListener("pointerdown", handlePointerDown, true)
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true)
      document.removeEventListener("pointerdown", handlePointerDown, true)
    }
  }, [activeIndex, onDismiss, onSelect, options, optionsKey])

  if (options.length === 0) return null

  return (
    <div
      ref={pickerRef}
      role="listbox"
      aria-label={label}
      className="absolute right-0 bottom-[calc(100%+10px)] left-0 z-40 overflow-hidden rounded-2xl bg-background/95 py-2 shadow-composer ring-1 ring-black/7 backdrop-blur dark:bg-card/95 dark:ring-white/12"
      onWheel={(event) => event.stopPropagation()}
    >
      <div className="px-4 pt-1 pb-1.5 text-xs font-medium text-muted-foreground">{label}</div>
      <div className="max-h-72 scroll-py-1 scrollbar-thin overflow-y-auto overscroll-contain px-2 pb-1">
        {options.map((item, index) => {
          const Icon = item.command?.icon ?? (item.kind === "command" ? Command : Box)
          return (
            <Button
              key={item.id}
              ref={(element) => {
                optionRefs.current[index] = element
              }}
              type="button"
              variant="ghost"
              role="option"
              aria-selected={index === activeIndex}
              title={`${item.label} — ${item.description}`}
              onMouseEnter={() => setHighlighted({ key: optionsKey, index })}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onSelect(item)}
              className={cn(
                "flex h-9 w-full justify-start gap-2 rounded-lg px-2 text-left font-normal",
                index === activeIndex && "bg-muted text-foreground"
              )}
            >
              <span className="grid size-5 shrink-0 place-items-center text-muted-foreground">
                <Icon className="size-3.5" />
              </span>
              <span className="max-w-[42%] min-w-0 shrink-0 truncate text-sm font-medium">
                {item.label}
              </span>
              <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
                {item.description}
              </span>
              {item.sourceLabel ? (
                <span className="ml-auto shrink-0 text-xs text-muted-foreground/65">
                  {item.sourceLabel}
                </span>
              ) : null}
            </Button>
          )
        })}
      </div>
    </div>
  )
}

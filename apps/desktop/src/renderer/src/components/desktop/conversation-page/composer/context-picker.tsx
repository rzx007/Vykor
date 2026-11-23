import { Eye, Goal, ListChecks, MessageSquare, Monitor, Paperclip } from "lucide-react"
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react"

import { Button } from "@renderer/components/ui/button"
import { cn } from "@renderer/lib/utils"
import { ExtensionIcon } from "../../plugin-page/shared/plugin-catalog"

export interface ContextPickerItem {
  id: string
  label: string
  description: string
  group: string
  sourceLabel?: string
  icon?: string
  observation?: { priority: number; workspace: string; status: string; updatedAt: number }
  action:
    | { kind: "files" }
    | { kind: "window-picture" }
    | { kind: "plan" }
    | { kind: "goal" }
    | { kind: "observe-mode" }
    | { kind: "observe-session"; sessionId: string }
    | { kind: "plugin"; pluginId: string; displayName: string }
    | { kind: "conversation"; sessionId: string; displayName: string }
}

export function ContextPicker({
  items,
  query,
  onSelect,
  onDismiss,
}: {
  items: readonly ContextPickerItem[]
  query: string
  onSelect: (item: ContextPickerItem) => void
  onDismiss: () => void
}): React.JSX.Element {
  const normalized = query.trim().toLocaleLowerCase()
  const [observationMode, setObservationMode] = useState(false)
  const modeItem = items.find((item) => item.action.kind === "observe-mode")
  const observing = Boolean(modeItem && observationMode)
  const options = useMemo(() => {
    const matches = items.filter((item) => {
      if (item.action.kind === "observe-mode") return false
      if (observing && !item.observation) return false
      const text = observing ? item.label : `${item.label} ${item.description}`
      return text.toLocaleLowerCase().includes(normalized)
    })
    if (observing) {
      matches.sort((left, right) =>
        left.observation!.priority - right.observation!.priority ||
        right.observation!.updatedAt - left.observation!.updatedAt
      )
    }
    if (modeItem) matches.push(modeItem)
    return matches
  }, [items, modeItem, normalized, observing])
  const firstId = options[0]?.id
  const [highlighted, setHighlighted] = useState({ query, observing, id: firstId })
  const highlightedIndex = options.findIndex((item) => item.id === highlighted.id)
  if (highlighted.query !== query || highlighted.observing !== observing ||
    (highlightedIndex < 0 && highlighted.id !== firstId)) {
    setHighlighted({ query, observing, id: firstId })
  }
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([])
  const pickerRef = useRef<HTMLDivElement | null>(null)
  const activeIndex = Math.max(0, highlightedIndex)
  const select = useCallback(
    (item: ContextPickerItem): void => {
      const { action } = item
      if (action.kind === "observe-mode") {
        setObservationMode(!observing)
      } else if (observing && action.kind === "conversation") {
        onSelect({ ...item, action: { kind: "observe-session", sessionId: action.sessionId } })
      } else onSelect(item)
    },
    [onSelect, observing]
  )

  useEffect(() => {
    optionRefs.current[activeIndex]?.scrollIntoView?.({ block: "nearest" })
  }, [activeIndex, observing, query])
  useEffect(() => {
    const moveHighlight = (step: number): void => {
      setHighlighted((current) => {
        const index = Math.max(0, options.findIndex((item) => item.id === current.id))
        const next = (index + step + options.length) % options.length
        return { ...current, id: options[next]?.id }
      })
    }
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.isComposing || event.keyCode === 229) return
      if (event.key === "Escape") {
        event.preventDefault()
        onDismiss()
      } else if (options.length > 0 && event.key === "ArrowDown") {
        event.preventDefault()
        moveHighlight(1)
      } else if (options.length > 0 && event.key === "ArrowUp") {
        event.preventDefault()
        moveHighlight(-1)
      } else if (options.length > 0 && (event.key === "Enter" || event.key === "Tab")) {
        event.preventDefault()
        event.stopPropagation()
        select(options[activeIndex]!)
      }
    }
    const handlePointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Element && event.target.closest("[data-context-picker-toggle]"))
        return
      if (event.target instanceof Node && !pickerRef.current?.contains(event.target)) onDismiss()
    }
    window.addEventListener("keydown", handleKeyDown, true)
    document.addEventListener("pointerdown", handlePointerDown, true)
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true)
      document.removeEventListener("pointerdown", handlePointerDown, true)
    }
  }, [activeIndex, onDismiss, options, select])

  return (
    <div
      ref={pickerRef}
      role="listbox"
      aria-label={observing ? "观察进度" : "添加上下文"}
      className="absolute right-0 bottom-[calc(100%+10px)] left-0 z-40 overflow-hidden rounded-2xl bg-background/95 py-2 shadow-composer ring-1 ring-black/7 backdrop-blur dark:bg-card/95 dark:ring-white/12"
    >
      <div className="px-5 pt-1 pb-2 text-sm text-muted-foreground">
        {observing ? "观察进度" : "添加"}
      </div>
      <div className="max-h-80 scrollbar-thin overflow-y-auto overscroll-contain px-3 pb-2">
        {options.length === (modeItem ? 1 : 0) ? (
          <p className="px-2 py-3 text-sm text-muted-foreground">
            {observing ? "没有匹配的会话" : "没有匹配的上下文"}
          </p>
        ) : null}
        {options.map((item, index) => {
          const isMode = item === modeItem
          const observation = observing ? item.observation : undefined
          const label = isMode && observing ? "引用历史" : item.label
          const description = isMode && observing
            ? "添加历史会话作为参考"
            : observation?.workspace ?? item.description
          const sourceLabel = observation?.status ?? item.sourceLabel
          return (
            <Fragment key={item.id}>
              {!observing && item.group !== "添加" && item.group !== options[index - 1]?.group ? (
                <div role="presentation" className="px-2 pt-3 pb-1 text-sm text-muted-foreground">
                  {item.group}
                </div>
              ) : null}
              <Button
                ref={(element) => {
                  optionRefs.current[index] = element
                }}
                type="button"
                variant="ghost"
                role="option"
                aria-selected={index === activeIndex}
                title={[label, description, observation?.status].filter(Boolean).join(" — ")}
                onMouseEnter={() => setHighlighted({ query, observing, id: item.id })}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => select(item)}
                className={cn(
                  "flex h-10 w-full justify-start gap-2 rounded-xl px-2 text-left font-normal",
                  index === activeIndex && "bg-muted text-foreground"
                )}
              >
                <span className="grid size-6 shrink-0 place-items-center text-muted-foreground">
                  {item.action.kind === "plugin" ? (
                    <ExtensionIcon name={item.label} src={item.icon} size="sm" />
                  ) : item.action.kind === "files" ? (
                    <Paperclip className="size-4" />
                  ) : item.action.kind === "window-picture" ? (
                    <Monitor className="size-4" />
                  ) : item.action.kind === "plan" ? (
                    <ListChecks className="size-4" />
                  ) : item.action.kind === "goal" ? (
                    <Goal className="size-4" />
                  ) : item.action.kind === "observe-mode" && !observing ? (
                    <Eye className="size-4" />
                  ) : (
                    <MessageSquare className="size-4" />
                  )}
                </span>
                <span className="max-w-[42%] min-w-0 shrink-0 truncate text-sm font-medium">
                  {label}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
                  {description}
                </span>
                {sourceLabel ? (
                  <span className="ml-auto shrink-0 text-sm text-muted-foreground/65">
                    {sourceLabel}
                  </span>
                ) : null}
              </Button>
            </Fragment>
          )
        })}
      </div>
    </div>
  )
}

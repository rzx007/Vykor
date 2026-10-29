import { ChevronDown, ChevronUp, Search, X } from "lucide-react"
import type * as React from "react"
import { useEffect, useRef } from "react"
import { Button } from "@renderer/components/ui/button"

export function FileSearchControls({
  query,
  placeholder = "搜索当前文件",
  maxLength,
  emptyLabel = "No results",
  matchCount,
  matchIndex,
  disabled,
  onQueryChange,
  onPrevious,
  onNext,
  onClose,
}: {
  query: string
  placeholder?: string
  maxLength?: number
  emptyLabel?: string
  matchCount: number
  matchIndex: number
  disabled: boolean
  onQueryChange: (query: string) => void
  onPrevious: () => void
  onNext: () => void
  onClose: () => void
}): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const hasQuery = query.trim().length > 0
  const canNavigate = hasQuery && matchCount > 0

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  return (
    <div className="flex h-9 min-w-0 items-center gap-0.5 rounded-full border border-border bg-popover px-1.5 text-ui-muted shadow-sm">
      <Search className="ml-1 size-4 shrink-0" strokeWidth={1.75} />
      <input
        ref={inputRef}
        value={query}
        disabled={disabled}
        placeholder={placeholder}
        aria-label={placeholder}
        maxLength={maxLength}
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return
          if (event.key === "Enter") {
            event.preventDefault()
            if (!canNavigate) return
            if (event.shiftKey) {
              onPrevious()
            } else {
              onNext()
            }
            return
          }

          if (event.key === "Escape") {
            event.preventDefault()
            onClose()
          }
        }}
        className="text-ui-small h-full min-w-0 flex-1 bg-transparent px-2 text-ui-foreground placeholder:text-ui-muted focus:outline-none disabled:cursor-not-allowed disabled:opacity-45"
      />
      {hasQuery && (
        <span className="shrink-0 px-1 text-xs text-ui-muted tabular-nums">
          {matchCount > 0 ? `${matchIndex + 1}/${matchCount}` : emptyLabel}
        </span>
      )}
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        shape="circle"
        aria-label="上一个搜索结果"
        title="上一个搜索结果"
        disabled={!canNavigate}
        onClick={onPrevious}
      >
        <ChevronUp className="size-3.5" strokeWidth={1.75} />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        shape="circle"
        aria-label="下一个搜索结果"
        title="下一个搜索结果"
        disabled={!canNavigate}
        onClick={onNext}
      >
        <ChevronDown className="size-3.5" strokeWidth={1.75} />
      </Button>
      <span aria-hidden="true" className="mx-1 h-4 w-px shrink-0 bg-border" />
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        shape="circle"
        aria-label="关闭搜索"
        title="关闭搜索"
        onClick={onClose}
      >
        <X className="size-3.5" strokeWidth={1.75} />
      </Button>
    </div>
  )
}

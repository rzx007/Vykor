import { ChevronDown, ChevronUp, Search, X } from "lucide-react"
import type * as React from "react"
import { useEffect, useRef } from "react"
import { Button } from "@renderer/components/ui/button"

export function FileSearchControls({
  query,
  matchCount,
  matchIndex,
  disabled,
  onQueryChange,
  onPrevious,
  onNext,
  onClose,
}: {
  query: string
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
    <div className="flex h-12 min-w-0 shrink-0 items-center rounded-xl border border-border/70 bg-popover px-2 text-ui-muted shadow-lg shadow-black/12 dark:border-white/12 dark:shadow-black/35">
      <Search className="ml-0.5 size-4 shrink-0" strokeWidth={1.8} />
      <input
        ref={inputRef}
        value={query}
        disabled={disabled}
        placeholder="搜索当前文件"
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={(event) => {
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
        className="text-ui-small h-full w-52 min-w-0 bg-transparent px-2 text-ui-foreground placeholder:text-ui-muted focus:outline-none disabled:cursor-not-allowed disabled:opacity-45"
      />
      {hasQuery && (
        <span className="shrink-0 px-2 text-xs text-ui-muted tabular-nums">
          {matchCount > 0 ? `${matchIndex + 1}/${matchCount}` : "No results"}
        </span>
      )}
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="上一个搜索结果"
        title="上一个搜索结果"
        disabled={!canNavigate}
        onClick={onPrevious}
      >
        <ChevronUp />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="下一个搜索结果"
        title="下一个搜索结果"
        disabled={!canNavigate}
        onClick={onNext}
      >
        <ChevronDown />
      </Button>
      <Button
        type="button"
        size="icon-sm"
        aria-label="关闭搜索"
        title="关闭搜索"
        onClick={onClose}
        className="-mt-9 -mr-4 ml-1 rounded-full bg-muted-foreground text-popover hover:bg-foreground"
      >
        <X />
      </Button>
    </div>
  )
}

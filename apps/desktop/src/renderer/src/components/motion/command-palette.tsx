"use client"
// Adapted from beui.dev/components/blocks/command-palette.
// 复用 beUI 的搜索、分组和行光标；弹窗交给现有 Base UI 处理焦点与关闭。
import { motion, useReducedMotion } from "motion/react"
import { Search, type LucideIcon } from "lucide-react"
import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@renderer/components/ui/dialog"
import { useOnOpen } from "@renderer/lib/hooks/use-on-open"
import { useRowCursor } from "@renderer/lib/hooks/use-row-cursor"
import { useTouchCapable } from "@renderer/lib/hooks/use-touch-capable"
import { cn } from "@renderer/lib/utils"
import { searchCommands } from "@renderer/lib/command-search"

export type CommandItem = {
  id: string
  label: string
  group?: string
  hint?: string
  keywords?: string[]
  icon?: LucideIcon
  badge?: ReactNode
  onSelect: () => void
}
export interface CommandPaletteProps {
  items: CommandItem[]
  /** null 表示由应用的快捷键系统统一控制打开。 */
  shortcut?: string | null
  placeholder?: string
  emptyMessage?: string
  open?: boolean
  onOpenChange?: (open: boolean) => void
  className?: string
  label?: string
  groupOrder?: readonly string[]
  initialGroupLimits?: Readonly<Record<string, number>>
  renderHint?: (item: CommandItem, index: number) => string | undefined
  onKeyDown?: (event: KeyboardEvent, rows: CommandItem[]) => void
}

export function CommandPalette({
  items,
  shortcut = "k",
  placeholder = "搜索聊天或操作…",
  emptyMessage = "没有找到匹配的结果。",
  open: controlledOpen,
  onOpenChange,
  className,
  label = "搜索",
  groupOrder,
  initialGroupLimits,
  renderHint,
  onKeyDown: consumerKeyDown,
}: CommandPaletteProps): React.JSX.Element {
  const [internalOpen, setInternalOpen] = useState(false)
  const open = controlledOpen ?? internalOpen
  const setOpen = useCallback(
    (value: boolean) => {
      if (controlledOpen === undefined) setInternalOpen(value)
      onOpenChange?.(value)
    },
    [controlledOpen, onOpenChange]
  )
  const [query, setQuery] = useState("")
  const uid = useId()
  const reduce = useReducedMotion()
  const canTouch = useTouchCapable()
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!shortcut) return
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.isComposing || event.repeat) return
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === shortcut.toLowerCase()) {
        event.preventDefault()
        setOpen(!open)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open, shortcut, setOpen])

  const filtered = useMemo(() => searchCommands(items, query), [items, query])
  const hasIcons = useMemo(() => items.some((item) => item.icon), [items])
  const grouped = useMemo(() => {
    const map = new Map<string, CommandItem[]>()
    filtered.forEach((item) => {
      const group = item.group ?? "结果"
      const list = map.get(group) ?? []
      if (!query.trim() && list.length >= (initialGroupLimits?.[group] ?? Infinity)) return
      list.push(item)
      map.set(group, list)
    })
    const groups = Array.from(map.entries())
    if (groupOrder)
      groups.sort(([a], [b]) => {
        const ai = groupOrder.indexOf(a),
          bi = groupOrder.indexOf(b)
        return (ai < 0 ? groupOrder.length : ai) - (bi < 0 ? groupOrder.length : bi)
      })
    return groups
  }, [filtered, query, groupOrder, initialGroupLimits])
  const rows = useMemo(() => grouped.flatMap(([, list]) => list), [grouped])
  const { activeIndex: active, moveTo, moveActive } = useRowCursor(rows, query)
  useOnOpen(open, () => {
    setQuery("")
    moveTo(null)
  })

  const select = (item: CommandItem): void => {
    setOpen(false)
    item.onSelect()
  }
  const keyDown = (event: KeyboardEvent): void => {
    if (event.nativeEvent.isComposing) return
    consumerKeyDown?.(event, rows)
    if (event.defaultPrevented) return
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      moveActive(event.key === "ArrowDown" ? 1 : -1)
    } else if (event.key === "Enter") {
      event.preventDefault()
      if (rows[active]) select(rows[active])
    }
  }
  useEffect(() => {
    if (open)
      listRef.current
        ?.querySelector<HTMLButtonElement>('[data-index="' + active + '"]')
        ?.scrollIntoView({ block: "nearest" })
  }, [active, open, rows])

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        showCloseButton={false}
        initialFocus={inputRef}
        onKeyDown={keyDown}
        className={cn(
          "top-[16vh] max-h-[54dvh] translate-y-0 gap-0 overflow-hidden rounded-2xl p-0 sm:max-w-[42rem]",
          className
        )}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>{label}</DialogTitle>
          <DialogDescription>
            输入关键词搜索聊天、快捷操作或设置。使用上下方向键选择，回车打开。
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-3 px-5">
          <Search
            aria-hidden="true"
            className="size-4 shrink-0 text-muted-foreground"
            strokeWidth={1.75}
          />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={placeholder}
            aria-label={label}
            role="combobox"
            aria-expanded={open}
            aria-controls={uid + "-list"}
            aria-activedescendant={rows.length ? uid + "-opt-" + active : undefined}
            aria-autocomplete="list"
            className={cn(
              "h-14 min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground",
              canTouch && "text-base"
            )}
          />
          <kbd className="hidden rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground sm:inline-block">
            Esc
          </kbd>
        </div>
        <div
          ref={listRef}
          id={uid + "-list"}
          role="listbox"
          aria-label="搜索结果"
          className="max-h-[40dvh] overflow-y-auto overscroll-contain px-2 pb-3"
        >
          {rows.length === 0 ? (
            <p role="status" className="px-5 py-8 text-center text-sm text-muted-foreground">
              {emptyMessage}
            </p>
          ) : (
            grouped.map(([group, list]) => (
              <div key={group} role="group" aria-label={group}>
                <div aria-hidden="true" className="px-3 pt-4 pb-1.5 text-xs text-muted-foreground">
                  {group}
                </div>
                {list.map((item) => {
                  const index = rows.indexOf(item),
                    isActive = index === active,
                    Icon = item.icon
                  const hint = renderHint ? renderHint(item, index) : item.hint
                  return (
                    <button
                      key={item.id}
                      type="button"
                      id={uid + "-opt-" + index}
                      role="option"
                      aria-selected={isActive}
                      data-index={index}
                      onMouseEnter={() => moveTo(item.id)}
                      onFocus={() => moveTo(item.id)}
                      onClick={() => select(item)}
                      className={cn(
                        "relative isolate flex min-h-10 w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        isActive ? "text-foreground" : "text-muted-foreground"
                      )}
                    >
                      {isActive ? (
                        <motion.span
                          aria-hidden="true"
                          layoutId={uid + "-active"}
                          className="pointer-events-none absolute inset-0 rounded-xl bg-muted/70"
                          transition={
                            reduce
                              ? { duration: 0 }
                              : { type: "spring", stiffness: 480, damping: 38 }
                          }
                        />
                      ) : null}
                      {Icon ? (
                        <Icon
                          aria-hidden="true"
                          className="relative size-4 shrink-0"
                          strokeWidth={1.75}
                        />
                      ) : hasIcons ? (
                        <span aria-hidden="true" className="relative size-4 shrink-0" />
                      ) : null}
                      <span className="relative min-w-0 flex-1 truncate">{item.label}</span>
                      {item.badge ? (
                        <span className="relative hidden max-w-40 min-w-0 truncate text-xs text-muted-foreground sm:block">
                          {item.badge}
                        </span>
                      ) : null}
                      {hint ? (
                        <kbd className="relative shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                          {hint}
                        </kbd>
                      ) : null}
                    </button>
                  )
                })}
              </div>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

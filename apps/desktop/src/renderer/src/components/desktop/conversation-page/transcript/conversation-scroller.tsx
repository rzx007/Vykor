import {
  useCallback,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentProps,
  type ReactNode,
} from "react"
import { ArrowDownIcon, ShieldAlertIcon } from "lucide-react"
import { Button } from "@renderer/components/ui/button"
import { Spinner } from "@renderer/components/ui/spinner"
import { Tooltip, TooltipTrigger, TooltipContent } from "@renderer/components/ui/tooltip"
import { cn } from "@renderer/lib/utils"
import { createConversationScrollState } from "./conversation-scroll-state"
import type { ScrollerAgentStatus } from "./scroller-agent-status"
import { ConversationScrollContext, useConversationScroller } from "./conversation-scroll-context"

// 工具输出和代码块有自己的滚动区域，只有滚动将传给外层时才改变阅读意图。
function consumesScroll(
  target: EventTarget | null,
  viewport: HTMLElement,
  direction: number
): boolean {
  for (
    let element = target instanceof Element ? target : null;
    element && element !== viewport;
    element = element.parentElement
  ) {
    if (!(element instanceof HTMLElement)) continue
    const style = window.getComputedStyle(element)
    if (!/auto|scroll/.test(style.overflowY)) continue
    if (element.scrollHeight <= element.clientHeight) continue
    if (style.overscrollBehaviorY === "contain" || style.overscrollBehaviorY === "none") return true
    if (
      direction < 0
        ? element.scrollTop > 0
        : element.scrollTop + element.clientHeight < element.scrollHeight
    )
      return true
  }
  return false
}

export function ConversationScrollerProvider({ children }: { children?: ReactNode }) {
  const [state] = useState(createConversationScrollState)
  return <ConversationScrollContext value={state}>{children}</ConversationScrollContext>
}

export function ConversationScroller({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="message-scroller"
      className={cn("relative flex size-full min-h-0 flex-col overflow-hidden", className)}
      {...props}
    />
  )
}

export function ConversationScrollerViewport({
  className,
  ref,
  onScroll,
  onWheel,
  onKeyDown,
  onTouchStart,
  onTouchMove,
  ...props
}: ComponentProps<"div">) {
  const state = useConversationScroller()!
  const touchY = useRef<number | null>(null)
  const setViewport = useCallback(
    (element: HTMLDivElement | null) => {
      state.setViewport(element)
      if (typeof ref === "function") ref(element)
      else if (ref) ref.current = element
    },
    [state, ref]
  )
  return (
    <div
      data-slot="message-scroller-viewport"
      role="region"
      aria-label="Messages"
      tabIndex={0}
      ref={setViewport}
      className={cn(
        "size-full min-h-0 min-w-0 scroll-fade-b scrollbar-thin scrollbar-gutter-stable overflow-y-auto overscroll-contain contain-content [overflow-anchor:none]",
        className
      )}
      onScroll={(event) => {
        if (event.target === event.currentTarget) state.onScroll()
        onScroll?.(event)
      }}
      onWheel={(event) => {
        if (
          event.deltaY &&
          !event.defaultPrevented &&
          !consumesScroll(event.target, event.currentTarget, event.deltaY)
        )
          state.setIntent(event.deltaY < 0 ? -1 : 1)
        onWheel?.(event)
      }}
      onKeyDown={(event) => {
        const target = event.target as HTMLElement
        if (
          event.defaultPrevented ||
          target.closest("input, textarea, select, button, [contenteditable=true], [role=textbox]")
        ) {
          onKeyDown?.(event)
          return
        }
        const direction =
          ["ArrowUp", "PageUp", "Home"].includes(event.key) || (event.key === " " && event.shiftKey)
            ? -1
            : 1
        if (consumesScroll(event.target, event.currentTarget, direction)) {
          onKeyDown?.(event)
          return
        }
        if (
          ["ArrowUp", "PageUp", "Home"].includes(event.key) ||
          (event.key === " " && event.shiftKey)
        )
          state.setIntent(-1)
        else if (["ArrowDown", "PageDown", "End", " "].includes(event.key)) state.setIntent(1)
        onKeyDown?.(event)
      }}
      onTouchStart={(event) => {
        touchY.current = event.touches[0]?.clientY ?? null
        onTouchStart?.(event)
      }}
      onTouchMove={(event) => {
        const nextY = event.touches[0]?.clientY
        if (
          nextY !== undefined &&
          touchY.current !== null &&
          nextY !== touchY.current &&
          !consumesScroll(event.target, event.currentTarget, touchY.current - nextY)
        )
          state.setIntent(nextY > touchY.current ? -1 : 1)
        touchY.current = nextY ?? null
        onTouchMove?.(event)
      }}
      {...props}
    />
  )
}

export function ConversationScrollerContent({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="message-scroller-content"
      role="log"
      aria-relevant="additions"
      className={cn("min-h-full min-w-0", className)}
      {...props}
    />
  )
}

export function ConversationScrollerItem({
  className,
  messageId,
  scrollAnchor = false,
  ...props
}: ComponentProps<"div"> & { messageId?: string; scrollAnchor?: boolean }) {
  return (
    <div
      data-slot="message-scroller-item"
      data-message-id={messageId}
      data-scroll-anchor={scrollAnchor ? "true" : "false"}
      className={cn("min-w-0 shrink-0", className)}
      {...props}
    />
  )
}

export function ConversationScrollerButton({
  className,
  children,
  onClick,
  title,
  status,
  ...props
}: ComponentProps<typeof Button> & { status?: ScrollerAgentStatus | null }) {
  const state = useConversationScroller()!
  const snapshot = useSyncExternalStore(state.subscribe, state.getSnapshot, state.getSnapshot)
  if (snapshot.atEnd) return null
  const hint = [status?.title ?? title, snapshot.hasNewContent ? "有新内容" : undefined, "回到最新"]
    .filter(Boolean)
    .join("，")
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="secondary"
            size="sm"
            shape="pill"
            aria-label={hint}
            className={cn(
              "absolute inset-s-1/2 bottom-5 max-w-[calc(100%_-_2rem)] -translate-x-1/2 border-border bg-background font-normal text-foreground transition-opacity duration-200 motion-reduce:transition-none",
              className
            )}
            onClick={(event) => {
              onClick?.(event)
              if (!event.defaultPrevented) state.scrollToEnd()
            }}
            {...props}
          />
        }
      >
        {children ?? (
          <>
            {status?.kind === "permission" ? (
              <ShieldAlertIcon aria-hidden="true" data-icon="inline-start" className="size-3.5" />
            ) : status ? (
              <Spinner
                aria-hidden="true"
                role={undefined}
                aria-label={undefined}
                data-icon="inline-start"
                className="size-3.5 [animation-duration:2s] motion-reduce:animate-none"
              />
            ) : (
              <ArrowDownIcon aria-hidden="true" data-icon="inline-start" className="size-3.5" />
            )}
            <span>回到最新</span>
            {!status && snapshot.hasNewContent ? (
              <span
                aria-hidden="true"
                className="size-1.5 shrink-0 rounded-full bg-current opacity-60"
              />
            ) : null}
          </>
        )}
      </TooltipTrigger>
      <TooltipContent>{hint}</TooltipContent>
    </Tooltip>
  )
}

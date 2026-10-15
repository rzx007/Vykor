"use client"
// beui.dev/components/motion/collapsible
// 本地适配：使用短促、无回弹的展开过渡，收起动画结束后卸载内容。

import { ChevronDown } from "lucide-react"
import {
  AnimatePresence,
  type HTMLMotionProps,
  isValidMotionProp,
  motion,
  useIsPresent,
  useReducedMotion,
} from "motion/react"
import {
  cloneElement,
  createContext,
  type ReactElement,
  type Ref,
  type RefObject,
  useCallback,
  useContext,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { EASE_OUT } from "@renderer/lib/ease"
import { cn } from "@renderer/lib/utils"

export type CollapsibleState = {
  open: boolean
  disabled: boolean
  setOpen: (open: boolean) => void
  toggle: () => void
}

type CollapsibleContextValue = CollapsibleState & {
  reduce: boolean
  contentId: string
  triggerId: string
  triggerRef: RefObject<HTMLButtonElement | null>
}

const CollapsibleContext = createContext<CollapsibleContextValue | null>(null)

function useCollapsibleContext(component: string) {
  const context = useContext(CollapsibleContext)
  if (!context) throw new Error(`${component} must be used within <Collapsible>`)
  return context
}

/** Shared state and actions for custom children inside a Collapsible root. */
// eslint-disable-next-line react-refresh/only-export-components -- beUI 的公开组合 API。
export function useCollapsible(): CollapsibleState {
  return useCollapsibleContext("useCollapsible")
}

function mergeRefs<T>(...refs: Array<Ref<T> | undefined>) {
  return (node: T | null) => {
    const cleanups = refs.map((ref) => {
      if (typeof ref === "function") return ref(node)
      if (ref) ref.current = node
      return undefined
    })
    if (!node) return
    return () => {
      refs.forEach((ref, index) => {
        const cleanup = cleanups[index]
        if (typeof cleanup === "function") cleanup()
        else if (typeof ref === "function") ref(null)
        else if (ref) ref.current = null
      })
    }
  }
}

export interface CollapsibleProps extends Omit<HTMLMotionProps<"div">, "layout"> {
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  disabled?: boolean
  /** Layout classes for the inner wrapper, separate from the animated surface. */
  contentClassName?: string
}

export function Collapsible({
  open: controlledOpen,
  defaultOpen = false,
  onOpenChange,
  disabled = false,
  className,
  contentClassName,
  children,
  style,
  ...props
}: CollapsibleProps) {
  const [internalOpen, setInternalOpen] = useState(defaultOpen)
  const open = controlledOpen ?? internalOpen
  const reduce = useReducedMotion() ?? false
  const id = useId()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const stateRef = useRef({
    open,
    controlled: controlledOpen !== undefined,
    disabled,
    onOpenChange,
  })
  useLayoutEffect(() => {
    stateRef.current = { open, controlled: controlledOpen !== undefined, disabled, onOpenChange }
  }, [controlledOpen, disabled, onOpenChange, open])
  const setOpen = useCallback((next: boolean) => {
    const state = stateRef.current
    if (state.disabled || next === state.open) return
    if (!state.controlled) {
      stateRef.current = { ...state, open: next }
      setInternalOpen(next)
    }
    state.onOpenChange?.(next)
  }, [])
  const toggle = useCallback(() => setOpen(!stateRef.current.open), [setOpen])
  const context = useMemo<CollapsibleContextValue>(
    () => ({
      open,
      disabled,
      reduce,
      contentId: `${id}-content`,
      triggerId: `${id}-trigger`,
      triggerRef,
      setOpen,
      toggle,
    }),
    [disabled, id, open, reduce, setOpen, toggle]
  )

  return (
    <CollapsibleContext.Provider value={context}>
      <motion.div
        {...props}
        layout={false}
        data-slot="collapsible"
        data-state={open ? "open" : "closed"}
        data-disabled={disabled || undefined}
        className={cn("relative w-full", className)}
        style={{ ...style, originY: 0 }}
      >
        <motion.div layout={false} className={cn("min-w-0", contentClassName)}>
          {children}
        </motion.div>
      </motion.div>
    </CollapsibleContext.Provider>
  )
}

export interface CollapsibleTriggerProps extends Omit<HTMLMotionProps<"button">, "id" | "layout"> {
  /** Reuse a button element or a component that forwards its props and ref to a button. */
  render?: ReactElement
}

export function CollapsibleTrigger({
  className,
  children,
  onClick,
  disabled,
  ref,
  render,
  style,
  ...props
}: CollapsibleTriggerProps) {
  const context = useCollapsibleContext("CollapsibleTrigger")
  const child = render as ReactElement<HTMLMotionProps<"button">> | undefined
  const childRef = child?.props.ref
  const mergedRef = useMemo(
    // eslint-disable-next-line react-hooks/refs -- 仅组合回调，ref.current 的读写均在提交阶段执行。
    () => mergeRefs(context.triggerRef, ref, childRef),
    [context.triggerRef, ref, childRef]
  )
  const unavailable = context.disabled || disabled || child?.props.disabled
  const handleClick: NonNullable<HTMLMotionProps<"button">["onClick"]> = (event) => {
    child?.props.onClick?.(event)
    onClick?.(event)
    if (!event.defaultPrevented && !unavailable) context.toggle()
  }
  const triggerProps = {
    id: context.triggerId,
    type: "button" as const,
    disabled: unavailable,
    "aria-expanded": context.open,
    "aria-controls": context.contentId,
    "data-slot": "collapsible-trigger",
    "data-state": context.open ? "open" : "closed",
    "data-disabled": unavailable || undefined,
    onClick: handleClick,
    ref: mergedRef,
  }

  if (child) {
    if (typeof child.type === "string" && child.type !== "button") {
      throw new Error(
        "CollapsibleTrigger render must be a button or a component that renders a button."
      )
    }
    const forwarded =
      typeof child.type === "string"
        ? Object.fromEntries(Object.entries(props).filter(([key]) => !isValidMotionProp(key)))
        : props
    return cloneElement(child, {
      ...forwarded,
      ...triggerProps,
      className: cn(className, child.props.className),
      style: { ...style, ...child.props.style },
      children: children === undefined ? child.props.children : children,
    })
  }

  return (
    <motion.button
      {...props}
      {...triggerProps}
      style={style}
      layout={false}
      className={cn(
        "flex min-h-10 w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm font-medium transition-colors outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
        className
      )}
    >
      {children}
    </motion.button>
  )
}

export interface CollapsibleContentProps extends Omit<
  HTMLMotionProps<"div">,
  "id" | "layout" | "animate" | "initial"
> {
  /** Padding and layout classes for the inner content. */
  contentClassName?: string
}

export function CollapsibleContent(props: CollapsibleContentProps) {
  const { open, reduce } = useCollapsibleContext("CollapsibleContent")
  if (reduce) return open ? <OpenCollapsibleContent {...props} /> : null
  return (
    <AnimatePresence initial={false}>
      {open ? <OpenCollapsibleContent key="content" {...props} /> : null}
    </AnimatePresence>
  )
}

function OpenCollapsibleContent({
  className,
  contentClassName,
  children,
  ref,
  style,
  ...props
}: CollapsibleContentProps) {
  const context = useCollapsibleContext("CollapsibleContent")
  const present = useIsPresent()
  const contentRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)
  const [height, setHeight] = useState(0)
  const [ready, setReady] = useState(false)
  const mergedRef = useMemo(() => mergeRefs(contentRef, ref), [ref])

  useLayoutEffect(() => {
    const inner = innerRef.current
    if (!inner || context.reduce || !present) return
    // 使用实际像素值，避免 Motion 为解析 auto 临时展开容器、测量并恢复页面滚动。
    const measure = () => setHeight(inner.offsetHeight)
    measure()
    // 长过程首次挂载可能占用主线程。先绘制收起状态，再启动计时，避免首帧就到终点。
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => setReady(true))
    })
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure)
    observer?.observe(inner)
    return () => {
      cancelAnimationFrame(frame)
      observer?.disconnect()
    }
  }, [context.reduce, present])

  useLayoutEffect(() => {
    if (!present && contentRef.current?.contains(document.activeElement)) {
      context.triggerRef.current?.focus({ preventScroll: true })
    }
  }, [present, context.triggerRef])

  useLayoutEffect(() => {
    const node = contentRef.current
    const trigger = context.triggerRef.current
    // 卸载前归还键盘焦点，防止焦点落回页面顶部并触发滚动。
    return () => {
      if (node?.contains(document.activeElement)) trigger?.focus({ preventScroll: true })
    }
  }, [context.triggerRef])

  return (
    <motion.div
      {...props}
      ref={mergedRef}
      id={context.contentId}
      role="region"
      aria-labelledby={context.triggerId}
      aria-hidden={!present}
      inert={!present}
      data-slot="collapsible-content"
      data-state={present ? "open" : "closed"}
      initial={context.reduce ? false : { height: 0, opacity: 0 }}
      animate={{
        height: context.reduce ? "auto" : ready ? height : 0,
        opacity: context.reduce || ready ? 1 : 0,
      }}
      exit={{ height: 0, opacity: 0 }}
      transition={{
        type: "tween",
        duration: context.reduce ? 0 : 0.16,
        ease: EASE_OUT,
        // 长过程第一帧的高度就可能超过视口，让淡入独立完成，仍能看见展开过渡。
        opacity: { duration: context.reduce ? 0 : 0.2, ease: "linear" },
      }}
      layout={false}
      style={style}
      className={cn("overflow-hidden", className)}
    >
      <motion.div ref={innerRef} layout={false} className={cn("flow-root", contentClassName)}>
        {children}
      </motion.div>
    </motion.div>
  )
}

export interface CollapsibleIndicatorProps extends HTMLMotionProps<"span"> {}

export function CollapsibleIndicator({ className, children, ...props }: CollapsibleIndicatorProps) {
  const { open, reduce } = useCollapsibleContext("CollapsibleIndicator")
  return (
    <motion.span
      {...props}
      aria-hidden="true"
      data-slot="collapsible-indicator"
      initial={false}
      animate={{ transform: `rotate(${open ? 180 : 0}deg)` }}
      transition={{ type: "tween", duration: reduce ? 0 : 0.15, ease: EASE_OUT }}
      className={cn(
        "ml-auto inline-flex shrink-0 items-center justify-center text-muted-foreground",
        className
      )}
    >
      {children ?? <ChevronDown className="size-4" />}
    </motion.span>
  )
}

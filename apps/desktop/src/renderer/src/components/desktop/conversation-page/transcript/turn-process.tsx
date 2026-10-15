import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { ChevronRight } from "lucide-react"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@renderer/components/motion/collapsible"
import { taskTimingLabel, type TaskTiming } from "../message/task-timing"
import type { TurnBlockPlanItem } from "./turn-block-plan"
import { splitTurnProcess } from "./turn-process-plan"
import type { DesktopSessionTask } from "@shared/session-types"

export function TurnProcess({
  plan,
  canCollapse,
  timing,
  tasks,
  children,
}: {
  plan: TurnBlockPlanItem[]
  canCollapse: boolean
  timing?: TaskTiming
  tasks?: readonly DesktopSessionTask[]
  children: (items: TurnBlockPlanItem[], folded: boolean) => ReactNode
}): React.JSX.Element {
  const candidate = useMemo(
    () => (canCollapse ? splitTurnProcess(plan, tasks) : null),
    [plan, canCollapse, tasks]
  )
  const eligible = Boolean(candidate)
  // 完成后的第一次提交仍保留原布局，检查阅读状态后才能切换为折叠布局。
  const [allowFold, setAllowFold] = useState(eligible)
  // 再次执行或分组失效时清除授权，下次完成仍需先检查阅读状态。
  if (!eligible && allowFold) setAllowFold(false)
  const split = allowFold ? candidate : null
  const folded = Boolean(split)
  const [open, setOpen] = useState(!eligible)
  const previousEligible = useRef(eligible)
  const manualChoice = useRef(false)
  const root = useRef<HTMLDivElement>(null)
  const readingEarlier = useRef(false)

  useLayoutEffect(() => {
    if (folded) return
    const viewport = root.current?.closest<HTMLElement>('[data-slot="message-scroller-viewport"]')
    if (!viewport) return
    const observe = (): void => {
      readingEarlier.current =
        viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight > 1
    }
    const onWheel = (event: WheelEvent): void => {
      if (event.deltaY < 0) readingEarlier.current = true
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (
        ["ArrowUp", "PageUp", "Home"].includes(event.key) ||
        (event.key === " " && event.shiftKey)
      ) {
        readingEarlier.current = true
      }
    }
    const onTouchStart = (): void => {
      readingEarlier.current = true
    }
    observe()
    viewport.addEventListener("scroll", observe, { passive: true })
    viewport.addEventListener("wheel", onWheel, { passive: true })
    viewport.addEventListener("keydown", onKeyDown)
    viewport.addEventListener("touchstart", onTouchStart, { passive: true })
    return () => {
      viewport.removeEventListener("scroll", observe)
      viewport.removeEventListener("wheel", onWheel)
      viewport.removeEventListener("keydown", onKeyDown)
      viewport.removeEventListener("touchstart", onTouchStart)
    }
  }, [folded])

  useLayoutEffect(() => {
    const justFinished = eligible && !previousEligible.current
    previousEligible.current = eligible
    if (!justFinished || manualChoice.current) return
    const selection = window.getSelection()
    const selecting =
      selection && !selection.isCollapsed && root.current?.contains(selection.anchorNode)
    const interacting = root.current?.contains(document.activeElement)
    // 用户阅读历史、选择文字或操作工具时保留展开，避免完成瞬间内容消失。
    if (!readingEarlier.current && !selecting && !interacting) {
      setAllowFold(true)
      setOpen(false)
    }
  }, [eligible])

  const label = (timing && taskTimingLabel(timing)) ?? "过程说明"

  return (
    <div ref={root} className="flex min-w-0 flex-col gap-6">
      {split ? (
        <>
          <Collapsible
            open={open}
            onOpenChange={(value) => {
              manualChoice.current = true
              setOpen(value)
            }}
            className="group/process min-w-0"
          >
            <div className="border-workspace border-b pb-2">
              <CollapsibleTrigger
                render={<button />}
                className="flex items-center gap-1 rounded-sm text-[length:var(--chat-font-size)] leading-[var(--chat-line-height)] text-ui-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                {label}
                <ChevronRight
                  aria-hidden="true"
                  className="size-3.5 text-ui-muted transition-transform duration-150 ease-out group-data-[state=open]/process:rotate-90 motion-reduce:transition-none"
                />
                <span className="sr-only">，过程说明</span>
              </CollapsibleTrigger>
            </div>
            {/* 展开前测量真实高度，避免延迟渲染的消息在动画中途替换占位高度。 */}
            <CollapsibleContent className="[&_[data-slot=message-scroller-item]]:[content-visibility:visible]">
              <div className="flex min-w-0 flex-col gap-6 pt-4">
                {children(split.process, true)}
              </div>
            </CollapsibleContent>
          </Collapsible>
          {children(split.answer, true)}
        </>
      ) : (
        children(plan, false)
      )}
    </div>
  )
}

import { useEffect, useRef, type RefObject } from "react"
import { Separator, type GroupImperativeHandle, type Layout } from "react-resizable-panels"

import { cn } from "@renderer/lib/utils"

type PanelResizeHandleProps = {
  label: string
  className?: string
  onPointerDown?: React.PointerEventHandler<HTMLDivElement>
  groupRef?: RefObject<GroupImperativeHandle | null>
  onReset?: (previousLayout: Layout | null) => void
}

export function PanelResizeHandle({
  label,
  className,
  onPointerDown,
  groupRef,
  onReset,
}: PanelResizeHandleProps): React.JSX.Element {
  const elementRef = useRef<HTMLDivElement | null>(null)
  const previousLayoutRef = useRef<Layout | null>(null)

  useEffect(() => {
    if (!groupRef) return
    const element = elementRef.current
    if (!element) return
    const doc = element.ownerDocument
    let drag: { layout: Layout; pointerId: number } | null = null
    let lastPointerDownWasResize = false
    const start = (event: PointerEvent) => {
      // The library focuses its separator even when the pointer lands in its wider
      // hit target. Listen after its document capture handler, without hit-test math.
      lastPointerDownWasResize = event.defaultPrevented && doc.activeElement === element
      if (!lastPointerDownWasResize) return
      const layout = groupRef.current?.getLayout()
      if (layout) drag = { layout: { ...layout }, pointerId: event.pointerId }
    }
    const finish = () => {
      const current = groupRef.current?.getLayout()
      if (
        drag &&
        current &&
        Object.values(drag.layout).every((size) => size > 0) &&
        Object.keys(drag.layout).some((id) => drag!.layout[id] !== current[id])
      ) {
        // Plain clicks (including both clicks of a double-click) retain the baseline.
        previousLayoutRef.current = drag.layout
      }
      drag = null
    }
    const cancel = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !drag) return
      // React publishes data-separator after pointerdown, so verify the library's
      // active state here instead of accepting an unrelated prevented click.
      if (element.dataset.separator !== "active") {
        drag = null
        return
      }
      event.preventDefault()
      event.stopPropagation()
      const { layout, pointerId } = drag
      drag = null
      groupRef.current?.setLayout(layout)
      if (element.hasPointerCapture?.(pointerId)) element.releasePointerCapture(pointerId)
      // End through the library's existing release handler after restoring, so its
      // completed-layout callback saves the original split and pointer moves stop.
      doc.dispatchEvent(new Event("pointerup", { bubbles: true }))
    }
    const resetFromHitTarget = (event: MouseEvent) => {
      // A neighboring panel can receive the click within the library's wider hit
      // target. Exact separator clicks already reach the React handler below.
      if (lastPointerDownWasResize && !element.contains(event.target as Node)) {
        onReset?.(previousLayoutRef.current)
      }
    }
    doc.addEventListener("pointerdown", start)
    doc.addEventListener("pointerup", finish)
    doc.addEventListener("keydown", cancel, true)
    doc.addEventListener("dblclick", resetFromHitTarget)
    return () => {
      doc.removeEventListener("pointerdown", start)
      doc.removeEventListener("pointerup", finish)
      doc.removeEventListener("keydown", cancel, true)
      doc.removeEventListener("dblclick", resetFromHitTarget)
    }
  }, [groupRef, onReset])

  return (
    <Separator
      elementRef={elementRef}
      aria-label={label}
      onPointerDown={onPointerDown}
      disableDoubleClick={Boolean(onReset)}
      onDoubleClick={() => onReset?.(previousLayoutRef.current)}
      className={cn(
        "relative z-40 w-px bg-transparent outline-none after:pointer-events-none after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:content-['']",
        "after:bg-linear-to-b after:from-transparent after:via-border after:to-transparent",
        "hover:after:via-primary focus-visible:after:via-primary data-[separator=active]:after:via-primary",
        className
      )}
    />
  )
}

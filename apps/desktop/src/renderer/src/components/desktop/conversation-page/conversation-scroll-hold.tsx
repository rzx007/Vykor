import { useLayoutEffect, useRef } from "react"

import {
  useMessageScroller,
  useMessageScrollerScrollable,
} from "@renderer/components/ui/message-scroller"

const HOLD_FRAMES = 12

/**
 * The scroller re-anchors to an earlier message when a run ends (the transcript
 * change that follows a stop). Hold the reader's position for a few frames: if
 * they were at the bottom, settle on the latest message; otherwise keep the
 * exact spot they had scrolled to.
 *
 * The layout effect runs before the scroller's own MutationObserver reacts, so
 * the captured position is the reader's, not the re-anchored one.
 */
export function ConversationScrollHold({
  running,
  viewportRef,
}: {
  running: boolean
  viewportRef: React.RefObject<HTMLDivElement | null>
}): null {
  const { scrollToEnd } = useMessageScroller()
  const { end } = useMessageScrollerScrollable()
  const wasRunningRef = useRef(running)
  const atBottomRef = useRef(!end)
  atBottomRef.current = !end

  useLayoutEffect(() => {
    const wasRunning = wasRunningRef.current
    wasRunningRef.current = running
    const viewport = viewportRef.current
    if (!wasRunning || running || !viewport) return
    const holdBottom = atBottomRef.current
    const target = viewport.scrollTop
    let frame = 0
    let raf = 0
    const tick = (): void => {
      if (frame++ >= HOLD_FRAMES) return
      if (holdBottom) scrollToEnd({ behavior: "auto" })
      else if (Math.abs(viewport.scrollTop - target) > 1) viewport.scrollTop = target
      raf = window.requestAnimationFrame(tick)
    }
    raf = window.requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(raf)
  }, [running, scrollToEnd, viewportRef])

  return null
}

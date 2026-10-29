"use client"

import { useEffect, useState } from "react"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { ThinkingOrb, type OrbSize, type OrbState } from "thinking-orbs"

import { cn } from "@renderer/lib/utils"

/* ─────────────────────────────────────────────────────────
 * LOADING STATE — thought-orb indicator for long-running work
 *
 * The orb (thinking-orbs) draws nine hand-tuned animations on a
 * plain 2D canvas. It picks its light/dark ink from the
 * `dark`/`light` class the appearance provider puts on <html>,
 * renders a static frame when the OS asks to reduce motion, and
 * pauses instances that scroll offscreen.
 *
 * The app's own 减少动态效果 preference is a separate switch, and a
 * canvas is invisible to the CSS rule in main.css that freezes
 * everything else — `useAppReducedMotion` pauses the orb itself,
 * which is what the old CSS loader got for free.
 *
 * `state` names what the run is doing; `size` 20 fits inline text
 * and 64 fits an avatar. Each size is tuned on its own, not scaled.
 *
 * Paired with a shimmering label and a live elapsed timer in mono
 * tabular figures. The orb carries no text, so the label stays the
 * single thing a screen reader announces for this region.
 * ───────────────────────────────────────────────────────── */

/** 跟随 <html data-reduced-motion>，与 terminal-tool 读这个属性的方式一致。 */
function useAppReducedMotion(): boolean {
  const [reduced, setReduced] = useState(readReducedMotion)
  useEffect(() => {
    const sync = () => setReduced(readReducedMotion())
    sync()
    const observer = new MutationObserver(sync)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-reduced-motion"],
    })
    return () => observer.disconnect()
  }, [])
  return reduced
}

function readReducedMotion(): boolean {
  if (typeof document === "undefined") return false
  return document.documentElement.dataset.reducedMotion === "true"
}

function useElapsed(enabled: boolean) {
  const [ds, setDs] = useState(0)
  useEffect(() => {
    if (!enabled) return
    const t = setInterval(() => setDs((d) => d + 1), 100)
    return () => clearInterval(t)
  }, [enabled])
  const total = ds / 10
  if (total < 60) return `${total.toFixed(1)}s`
  return `${Math.floor(total / 60)}m ${(total % 60).toFixed(1)}s`
}

export function LoadingState({
  label = "Churning",
  state = "working",
  size = 20,
  speed,
  paused = false,
  showElapsed = true,
  showIndicator = true,
  className,
}: {
  label?: string
  state?: OrbState
  /** 20 for inline text, 64 for an avatar slot; both are tuned designs */
  size?: OrbSize
  /** multiplier on the state's baked animation speed */
  speed?: number
  /** freeze the orb on its current frame */
  paused?: boolean
  showElapsed?: boolean
  /** 已结束的内联摘要只保留文字，不创建画布。 */
  showIndicator?: boolean
  className?: string
}) {
  const elapsed = useElapsed(showElapsed)
  const appReducedMotion = useAppReducedMotion()
  const systemReducedMotion = useReducedMotion()
  const reducedMotion = appReducedMotion || !!systemReducedMotion
  const frozen = paused || reducedMotion

  const indicator = (
    <>
      {showIndicator ? (
        <ThinkingOrb
          state={state}
          size={size}
          speed={speed}
          paused={frozen}
          aria-hidden
          data-orb-state={state}
          data-orb-paused={String(frozen)}
          className="shrink-0"
        />
      ) : null}
      {label ? (
        <span className={cn("min-w-0 truncate text-muted-foreground", !paused && "shimmer")}>
          {label}
        </span>
      ) : null}
    </>
  )

  return (
    <span
      role="status"
      aria-label={label || undefined}
      className={cn(
        "flex w-fit max-w-full min-w-0 items-center gap-2.5 text-[13px] font-medium",
        className
      )}
    >
      <span aria-hidden className="inline-grid max-w-full min-w-0 items-center">
        {reducedMotion ? (
          <span className="inline-flex min-w-0 items-center gap-2.5">{indicator}</span>
        ) : (
          <AnimatePresence initial={false}>
            <motion.span
              key={`${state}:${label}`}
              className="col-start-1 row-start-1 inline-flex min-w-0 items-center gap-2.5"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.16, ease: "easeOut" }}
            >
              {indicator}
            </motion.span>
          </AnimatePresence>
        )}
      </span>
      {showElapsed ? (
        <span className="font-mono text-[12px] font-normal text-muted-foreground/70 tabular-nums">
          {elapsed}
        </span>
      ) : null}
    </span>
  )
}

export default LoadingState

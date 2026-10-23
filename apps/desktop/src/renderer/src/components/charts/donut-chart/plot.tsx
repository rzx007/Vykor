"use client"

/* beUI source adapted to Vykor: keep data visible immediately, emphasize by
 * opacity rather than scaling, and use the desktop's 180ms motion budget. */

import { motion } from "motion/react"
import { type ReactNode } from "react"
import { EASE_OUT } from "@renderer/lib/ease"
import { cn } from "@renderer/lib/utils"
import { useDonutChart } from "./context"
import { DONUT_SIZE } from "./model"

const CENTER = DONUT_SIZE / 2
/** Scale around the ring's centre rather than each arc's own box. */
const RING_ORIGIN = {
  transformBox: "view-box",
  transformOrigin: `${CENTER}px ${CENTER}px`,
} as const

export type DonutChartPlotProps = {
  /** Centered overlay, usually `DonutChartCenter`. */
  children?: ReactNode
  className?: string
}

export function DonutChartPlot({ children, className }: DonutChartPlotProps) {
  const { placed, radius, thickness, active, setActive, label, reduce, canHover } = useDonutChart()

  return (
    <div className={cn("relative mx-auto aspect-square w-full max-w-64", className)}>
      <svg
        viewBox={`0 0 ${DONUT_SIZE} ${DONUT_SIZE}`}
        role="img"
        aria-label={label}
        className="size-full overflow-visible"
      >
        <circle
          cx={CENTER}
          cy={CENTER}
          r={radius}
          fill="none"
          strokeWidth={thickness}
          className="stroke-muted"
          opacity={0.6}
        />
        <motion.g style={RING_ORIGIN} initial={false}>
          {placed.map((segment) => {
            const focused = active === segment.id
            const dimmed = active !== null && !focused
            return (
              <motion.path
                key={segment.id}
                d={segment.path}
                fill="none"
                stroke={segment.color}
                strokeWidth={thickness}
                strokeLinecap={segment.linecap}
                style={RING_ORIGIN}
                initial={false}
                animate={{ opacity: dimmed ? 0.3 : 1 }}
                transition={{ duration: reduce ? 0 : 0.18, ease: EASE_OUT }}
                pointerEvents="none"
                aria-hidden="true"
              />
            )
          })}
        </motion.g>
        {/* Static, slightly wider hit arcs own hover. They never scale, so the
            pointer stays on the same segment while its visual pops. The svg's
            img role already hides them; the legend carries keyboard access. */}
        <g>
          {placed.map((segment) => (
            <path
              key={segment.id}
              d={segment.path}
              fill="none"
              stroke="transparent"
              strokeWidth={thickness + 8}
              strokeLinecap={segment.linecap}
              pointerEvents="stroke"
              className="cursor-pointer"
              onPointerEnter={canHover ? () => setActive(segment.id) : undefined}
              onPointerLeave={canHover ? () => setActive(null) : undefined}
            />
          ))}
        </g>
      </svg>
      {children ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-center">
          {children}
        </div>
      ) : null}
    </div>
  )
}

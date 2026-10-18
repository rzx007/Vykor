"use client"

import React, { useEffect, useId, useState } from "react"
import "./TaskRows.css"

/* ─────────────────────────────────────────────────────────
 * TASK ROWS
 *
 *     0ms   rows enter staggered (80ms apart)
 *   600ms   row 1 ring sweeps 0 → 66%
 *  1500ms   row 1 expands — detail steps drop down
 *  3900ms   row 1 collapses; row 2 flips to Failed + retry
 *  5300ms   row 2 resolves to Completed
 * The status run completes once; task details stay clickable.
 * ───────────────────────────────────────────────────────── */

const TICKS = [600, 900, 2400, 1400, 2400, 600]

function useTick(intervals: number[]) {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (tick >= intervals.length - 1) return
    const t = setTimeout(() => setTick((x) => x + 1), intervals[tick])
    return () => clearTimeout(t)
  }, [tick, intervals])
  return tick
}

function SpinnerRing({ active, children }: { active?: boolean; children?: React.ReactNode }) {
  const size = 24,
    stroke = 2
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  return (
    <span
      className="relative inline-flex shrink-0 items-center justify-center"
      style={{ width: size, height: size }}
    >
      <svg
        width={size}
        height={size}
        className="absolute inset-0"
        style={active ? { animation: "spin 1.1s linear infinite" } : undefined}
      >
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--line)"
          strokeWidth={stroke}
        />
        {active && (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke="var(--ink-3)"
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${c * 0.28} ${c * 0.72}`}
          />
        )}
      </svg>
      <span className="text-ink relative text-[10.5px] font-semibold tabular-nums">{children}</span>
    </span>
  )
}

function Badge({ tone, children }: { tone: "red" | "green"; children: React.ReactNode }) {
  return (
    <span
      className={`flex size-5.5 shrink-0 items-center justify-center rounded-full text-white ${tone === "red" ? "bg-red" : "bg-green"}`}
      style={{ animation: "pop-in 300ms cubic-bezier(0.23,1,0.32,1) both" }}
    >
      {children}
    </span>
  )
}

const XIcon = (
  <svg
    width="12"
    height="12"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="3.5"
    strokeLinecap="round"
  >
    <path d="M18 6L6 18M6 6l12 12" />
  </svg>
)
const CheckIcon = (
  <svg
    width="13"
    height="13"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="3.5"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M20 6L9 17l-5-5" />
  </svg>
)
const RetryIcon = (
  <svg
    width="12"
    height="12"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="3"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6" />
  </svg>
)

/* One detail line shown when a task row is expanded. */
export type TaskDetail = { label: string; meta: string }

/* A single task row.
 *  - "done"     → green check badge + completed pill (static)
 *  - "running"  → active spinner showing `step`, no pill (static)
 *  - "sequence" → animation-driven: pending spinner → failed → completed
 */
export type TaskRow = {
  key: string
  label: string
  amount: string
  status: "done" | "running" | "sequence" | "pending" | "failed" | "skipped" | "killed" | "unknown"
  statusLabel?: string
  ariaLabel?: string
  step?: number
  details: TaskDetail[]
}

export type TaskRowsLabels = {
  completed: string
  failed: string
}

const DEFAULT_LABELS: TaskRowsLabels = {
  completed: "Completed",
  failed: "Failed",
}

const TASK_ROWS: TaskRow[] = [
  {
    key: "verify",
    label: "Verified vendor records",
    amount: "12 suppliers",
    status: "done",
    details: [
      { label: "Matched tax and contact IDs", meta: "12/12" },
      { label: "Flagged stale records", meta: "0" },
    ],
  },
  {
    key: "index",
    label: "Build reorder task list",
    amount: "7 SKUs",
    status: "running",
    step: 2,
    details: [
      { label: "Reading POS export", meta: "3 files" },
      { label: "Scoring stockout risk", meta: "68%" },
    ],
  },
  {
    key: "draft",
    label: "Draft supplier emails",
    amount: "2 messages",
    status: "sequence",
    step: 3,
    details: [
      { label: "Cone supplier follow-up", meta: "draft" },
      { label: "Pistachio reorder note", meta: "draft" },
    ],
  },
]

export default function TaskRows({
  variant = "Capsules",
  rows = TASK_ROWS,
  labels,
  className,
  onToggleRow,
  renderDetails,
}: {
  variant?: string
  rows?: TaskRow[]
  labels?: Partial<TaskRowsLabels>
  className?: string
  onToggleRow?: (key: string, open: boolean) => void
  renderDetails?: (row: TaskRow) => React.ReactNode
}) {
  const demo = rows === TASK_ROWS
  const tick = useTick(demo ? TICKS : [])
  const id = useId()
  const [manualOpen, setManualOpen] = useState<Record<string, boolean>>({})
  const row2: "pending" | "failed" | "done" = tick < 3 ? "pending" : tick === 3 ? "failed" : "done"
  const copy = { ...DEFAULT_LABELS, ...labels }
  const stateFor = (row: TaskRow) => (row.status === "sequence" ? row2 : row.status)
  const statusFor = (row: TaskRow) =>
    row.statusLabel ??
    {
      done: copy.completed,
      failed: copy.failed,
      running: "Running",
      pending: "Pending",
      skipped: "Skipped",
      killed: "Stopped",
      unknown: "Unknown",
    }[stateFor(row)]

  const badgeFor = (row: TaskRow) => {
    const state = stateFor(row)
    if (state === "done") return <Badge tone="green">{CheckIcon}</Badge>
    if (state === "running") return <SpinnerRing active>{row.step}</SpinnerRing>
    if (state === "failed") return <Badge tone="red">{XIcon}</Badge>
    return <SpinnerRing>{row.step}</SpinnerRing>
  }

  const pillFor = (row: TaskRow) => {
    const state = stateFor(row)
    if (state === "done")
      return (
        <span className="bg-green-tint text-green inline-flex h-5.5 items-center rounded-full px-2 text-[11.5px] font-medium">
          {statusFor(row)}
        </span>
      )
    if (state === "running" || (row.status === "sequence" && state === "pending")) return null
    return state === "failed" ? (
      <span
        className="bg-red-tint text-red inline-flex h-5.5 items-center gap-1.5 rounded-full px-2 text-[11.5px] font-medium"
        style={{ animation: "fade-in 200ms ease-out both" }}
      >
        {statusFor(row)}{" "}
        {demo && row.status === "sequence" ? (
          <span style={{ animation: "spin 1.2s linear infinite" }} className="flex">
            {RetryIcon}
          </span>
        ) : null}
      </span>
    ) : (
      <span className="inline-flex h-5.5 items-center rounded-full bg-muted px-2 text-[11.5px] font-medium text-muted-foreground">
        {statusFor(row)}
      </span>
    )
  }

  const list = variant === "List"
  return (
    <div
      className={`task-rows flex w-full max-w-110 flex-col ${
        list
          ? "rounded-card bg-surface gap-0 self-start overflow-hidden shadow-card"
          : `${demo ? "min-h-[196px]" : ""}gap-2`
      }${className ? ` ${className}` : ""}`}
    >
      {rows.map((row, i) => {
        const open = manualOpen[row.key] ?? (demo && row.key === "index" && tick === 2)
        const detailId = `${id}-${i}`
        return (
          <div
            key={row.key}
            data-task-row={row.key}
            className={`hover:bg-inset self-stretch overflow-hidden transition-[border-radius,background-color] duration-300 ${
              list ? "border-line border-b last:border-0" : "bg-surface shadow-card"
            }`}
            style={{
              borderRadius: list ? 0 : open ? 14 : 22,
              animation: `task-rows-enter 450ms cubic-bezier(0.23,1,0.32,1) ${i * 80}ms both`,
            }}
          >
            <button
              type="button"
              aria-label={row.ariaLabel ?? row.label}
              aria-describedby={`${detailId}-status`}
              aria-expanded={open}
              aria-controls={detailId}
              title={row.label}
              onClick={() => {
                setManualOpen((current) => ({ ...current, [row.key]: !open }))
                onToggleRow?.(row.key, !open)
              }}
              className="flex h-11 w-full items-center gap-2.5 px-2.5 text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
            >
              <span className="flex size-6 shrink-0 items-center justify-center">
                {badgeFor(row)}
              </span>
              <span className="text-ink min-w-0 flex-1 truncate text-[13px] font-medium">
                {row.label}
              </span>
              <span className="text-ink-2 text-[12.5px] tabular-nums">{row.amount}</span>
              {pillFor(row)}
              <span
                aria-hidden="true"
                className="text-ink-3 -ml-2 flex size-7 shrink-0 items-center justify-center rounded-full"
              >
                <svg
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="transition-transform duration-300"
                  style={{ transform: open ? "rotate(180deg)" : "rotate(0)" }}
                >
                  <path d="M6 9l6 6 6-6" />
                </svg>
              </span>
            </button>
            <span id={`${detailId}-status`} className="sr-only">
              {statusFor(row)}
              {row.amount ? ` · ${row.amount}` : ""}
            </span>

            {/* dropdown detail — same expandable grammar as Chain of Thought */}
            <div
              id={detailId}
              aria-hidden={!open}
              inert={!open}
              className="grid transition-[grid-template-rows,opacity] duration-300"
              style={{
                gridTemplateRows: open ? "1fr" : "0fr",
                opacity: open ? 1 : 0,
                transitionTimingFunction: "cubic-bezier(0.23, 1, 0.32, 1)",
              }}
            >
              <div className="overflow-hidden">
                <div className="mb-2.5 grid grid-cols-[24px_1fr] gap-2.5 px-2.5">
                  <span aria-hidden className="bg-line mx-auto h-full w-px" />
                  <div className="flex flex-col gap-1.5">
                    {renderDetails
                      ? open
                        ? renderDetails(row)
                        : null
                      : row.details.map((d, j) => (
                          <div
                            key={d.label}
                            className="flex items-center justify-between"
                            style={
                              open
                                ? {
                                    animation: `task-rows-enter 300ms cubic-bezier(0.23,1,0.32,1) ${120 + j * 100}ms both`,
                                  }
                                : undefined
                            }
                          >
                            <span className="text-ink-2 text-[12px]">{d.label}</span>
                            <span className="text-ink-3 font-mono text-[11.5px] tabular-nums">
                              {d.meta}
                            </span>
                          </div>
                        ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

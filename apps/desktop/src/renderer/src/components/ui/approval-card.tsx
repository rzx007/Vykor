"use client"

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react"
import { Button } from "@renderer/components/ui/button"
import GlideMenu from "@renderer/components/ui/GlideMenu"
import { cn } from "@renderer/lib/utils"

/* ─────────────────────────────────────────────────────────
 * APPROVAL CARD (human-in-the-loop)
 * One question at a time. The stack slides vertically as you
 * move between questions (the card's height animates to fit),
 * the step counter rolls like an odometer, and the footer uses
 * pill actions — a quiet Skip and a dark Continue with a ⏎.
 * Single-choice answers auto-advance; multi-select waits.
 * ───────────────────────────────────────────────────────── */

export type ApprovalQuestion = {
  q: string
  type: "radio" | "check"
  options: string[]
}

const QUESTIONS: ApprovalQuestion[] = [
  {
    q: "How many flavors should we launch?",
    type: "radio",
    options: ["Three (core line)", "Five (full case)", "Just one hero"],
  },
  {
    q: "Which mix-ins should we stock?",
    type: "check",
    options: ["Chocolate chips", "Waffle bits", "Sprinkles"],
  },
  {
    q: "Which market do we enter first?",
    type: "radio",
    options: ["Food trucks", "Grocery freezers", "Scoop shops"],
  },
]

export type ApprovalLabels = {
  skip: string
  continue: string
  send: string
  customPlaceholder: string
  sentMessage: string
}

export type ApprovalAnswers = {
  selected: Record<number, number[]>
  custom: Record<number, string>
}

const DEFAULT_LABELS: ApprovalLabels = {
  skip: "Skip",
  continue: "Continue",
  send: "Send",
  customPlaceholder: "Something else…",
  sentMessage: "Answers sent",
}

const ROLL_MS = 400
const SLIDE = "360ms cubic-bezier(0.22, 1, 0.36, 1)"

/* odometer digits — each character that changes rolls up (or down) */
function RollingDigits({ value }: { value: string }) {
  const prevRef = useRef(value)
  const [oldVal, setOldVal] = useState(value)
  const [newVal, setNewVal] = useState(value)
  const [rolling, setRolling] = useState(false)
  const [shifted, setShifted] = useState(false)
  const [dir, setDir] = useState<"up" | "down">("up")

  useEffect(() => {
    if (prevRef.current === value) return
    const from = prevRef.current
    prevRef.current = value
    const fromN = parseInt(from, 10)
    const toN = parseInt(value, 10)
    setDir(Number.isFinite(fromN) && Number.isFinite(toN) && toN < fromN ? "down" : "up")
    setOldVal(from)
    setNewVal(value)
    setRolling(true)
    setShifted(false)

    let raf2 = 0
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setShifted(true))
    })
    const done = setTimeout(() => {
      setRolling(false)
      setOldVal(value)
      setShifted(false)
    }, ROLL_MS)

    return () => {
      cancelAnimationFrame(raf1)
      cancelAnimationFrame(raf2)
      clearTimeout(done)
    }
  }, [value])

  const chars = rolling ? newVal : oldVal

  return (
    <>
      {Array.from({ length: chars.length }, (_, i) => {
        const o = oldVal[i] ?? ""
        const n = chars[i] ?? ""
        if (!rolling || o === n) {
          return <span key={`${i}-${n}`}>{n}</span>
        }
        const top = dir === "down" ? n : o
        const bottom = dir === "down" ? o : n
        const restY = dir === "down" ? "0" : "-1em"
        const startY = dir === "down" ? "-1em" : "0"
        return (
          <span
            key={`${i}-${o}-${n}-${dir}`}
            style={{
              display: "inline-block",
              position: "relative",
              overflow: "hidden",
              height: "1em",
              lineHeight: "1em",
              verticalAlign: "-0.05em",
            }}
          >
            <span
              style={{
                display: "flex",
                flexDirection: "column",
                transition: "transform 350ms cubic-bezier(0.4, 0, 0.2, 1)",
                transform: `translateY(${shifted ? restY : startY})`,
              }}
            >
              <span style={{ height: "1em", lineHeight: "1em" }}>{top}</span>
              <span style={{ height: "1em", lineHeight: "1em" }}>{bottom}</span>
            </span>
          </span>
        )
      })}
    </>
  )
}

function Ico({ path, size = 14, sw = 2 }: { path: React.ReactNode; size?: number; sw?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={sw}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {path}
    </svg>
  )
}

export default function ApprovalCard({
  questions = QUESTIONS,
  labels,
  onSubmitted,
  onAnswerChange,
  resettable = true,
  className,
  dismissible = true,
}: {
  questions?: ApprovalQuestion[]
  labels?: Partial<ApprovalLabels>
  onSubmitted?: (answers: ApprovalAnswers) => void
  onAnswerChange?: (questionIndex: number, answer: number[]) => void
  resettable?: boolean
  className?: string
  dismissible?: boolean
  variant?: string
} = {}) {
  const t = { ...DEFAULT_LABELS, ...labels }
  const [qi, setQi] = useState(0)
  const [answers, setAnswers] = useState<Record<number, number[]>>({})
  const [custom, setCustom] = useState<Record<number, string>>({})
  const answersRef = useRef(answers)
  const customRef = useRef(custom)
  const [sent, setSent] = useState(false)
  const [open, setOpen] = useState(true)

  const advanceTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const questionRefs = useRef<(HTMLDivElement | null)[]>([])
  const measured = useRef(false)
  const [viewportH, setViewportH] = useState<number | undefined>(undefined)
  const [trackY, setTrackY] = useState(0)
  const [animate, setAnimate] = useState(false)
  // Until the first question is measured, render only the active one so the
  // initial (and SSR) height is Q1's height — not all questions stacked, which
  // would flash to full height and then shrink on mount.
  const [ready, setReady] = useState(false)

  const last = qi === questions.length - 1
  const selected = answers[qi] ?? []
  const hasAnswer = selected.length > 0 || Boolean(custom[qi]?.trim())

  const sync = (withAnim: boolean) => {
    const item = questionRefs.current[qi]
    if (!item) return
    const reduce =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    setViewportH(item.offsetHeight)
    setTrackY(item.offsetTop)
    setAnimate(withAnim && !reduce)
  }

  useLayoutEffect(() => {
    const withAnim = measured.current
    measured.current = true
    sync(withAnim)
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setReady(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qi, answers, custom, open, sent])

  useEffect(() => {
    const id = requestAnimationFrame(() => sync(measured.current))
    return () => cancelAnimationFrame(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qi])

  useEffect(
    () => () => {
      if (advanceTimer.current) clearTimeout(advanceTimer.current)
    },
    []
  )

  const goTo = (next: number) => {
    if (advanceTimer.current) clearTimeout(advanceTimer.current)
    setQi(Math.min(Math.max(next, 0), questions.length - 1))
  }

  const send = () => {
    if (advanceTimer.current) clearTimeout(advanceTimer.current)
    setSent(true)
    onSubmitted?.({ selected: answersRef.current, custom: customRef.current })
  }

  const advance = () => {
    if (last) send()
    else goTo(qi + 1)
  }

  const toggle = (index: number) => {
    const type = questions[qi].type
    setAnswers((current) => {
      const picked = current[qi] ?? []
      const next =
        type === "radio"
          ? [index]
          : picked.includes(index)
            ? picked.filter((item) => item !== index)
            : [...picked, index]
      onAnswerChange?.(qi, next)
      const updated = { ...current, [qi]: next }
      answersRef.current = updated
      return updated
    })
    if (type === "radio") {
      setCustom((current) => {
        const updated = { ...current, [qi]: "" }
        customRef.current = updated
        return updated
      })
      if (!last) {
        if (advanceTimer.current) clearTimeout(advanceTimer.current)
        advanceTimer.current = setTimeout(() => {
          setQi((current) => Math.min(questions.length - 1, current + 1))
        }, 480)
      }
    }
  }

  const reset = () => {
    setQi(0)
    setAnswers({})
    setCustom({})
    answersRef.current = {}
    customRef.current = {}
    setSent(false)
    setOpen(true)
    measured.current = false
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-control bg-surface text-ink shadow-btn hover:bg-hover px-3 py-2 text-[12.5px] font-medium transition-colors duration-150"
      >
        Open approval
      </button>
    )
  }

  if (sent) {
    return (
      <div
        className="flex w-full max-w-80 items-center gap-3"
        style={{ animation: "pop-in 260ms cubic-bezier(0.23,1,0.32,1) both" }}
      >
        <span className="bg-green-tint text-green inline-flex items-center gap-1.5 rounded-full py-1 pr-2.5 pl-1 text-[12.5px] font-medium">
          <span className="bg-green flex size-4.5 items-center justify-center rounded-full text-white">
            <svg
              width="11"
              height="11"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="3"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M20 6L9 17l-5-5" />
            </svg>
          </span>
          {t.sentMessage}
        </span>
        {resettable && (
          <button
            type="button"
            onClick={reset}
            className="text-ink-3 hover:text-ink text-[12px] font-medium transition-colors duration-150"
          >
            Start over
          </button>
        )}
      </div>
    )
  }

  return (
    <div className={cn("w-full", className)}>
      <div
        className="relative flex max-h-[min(34rem,55vh)] min-h-0 flex-col overflow-hidden rounded-xl border bg-background shadow-sm"
        style={{ animation: "fade-up 380ms cubic-bezier(0.23,1,0.32,1) both" }}
      >
        {dismissible ? (
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => setOpen(false)}
            className="absolute top-3 right-3 z-10 grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <Ico size={14} sw={2.2} path={<path d="M18 6L6 18M6 6l12 12" />} />
          </button>
        ) : null}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pt-4 pb-3 scrollbar-thin">
          {/* the question itself is the heading */}
          <div
            className="overflow-hidden"
            style={{ height: viewportH, transition: animate ? `height ${SLIDE}` : undefined }}
            aria-live="polite"
          >
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 26,
                transform: `translate3d(0, ${-trackY}px, 0)`,
                transition: animate ? `transform ${SLIDE}` : undefined,
                willChange: "transform",
              }}
            >
              {questions.map((question, qIdx) => {
                const active = qIdx === qi
                // Before the first measure, mount only the active question so the
                // card opens at its real height instead of flashing to full height.
                if (!ready && !active) return null
                const picked = answers[qIdx] ?? []
                const questionStyle: CSSProperties = {
                  opacity: active ? 1 : 0,
                  transition: animate ? `opacity ${SLIDE}` : undefined,
                  pointerEvents: active ? undefined : "none",
                }
                return (
                  <div
                    key={qIdx}
                    ref={(el) => {
                      questionRefs.current[qIdx] = el
                    }}
                    aria-hidden={active ? undefined : true}
                    style={questionStyle}
                  >
                    <div className="pr-8 text-sm leading-6 font-semibold text-foreground">{question.q}</div>
                    <GlideMenu
                      className="mt-3 flex flex-col gap-1.5"
                      highlightClassName="inset-x-0 rounded-lg bg-muted"
                    >
                      {question.options.map((option, i) => {
                        const on = picked.includes(i)
                        return (
                          <button
                            key={option}
                            type="button"
                            data-menu-row
                            aria-pressed={on}
                            tabIndex={active ? 0 : -1}
                            onClick={() => {
                              if (active) toggle(i)
                            }}
                            className={cn(
                              "relative z-10 flex min-h-9 items-center gap-2 rounded-lg border px-3 py-2 text-left transition-colors duration-100",
                              on
                                ? "border-border bg-muted text-foreground"
                                : "border-transparent text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                            )}
                          >
                            <span
                              className={cn(
                                "flex size-4 shrink-0 items-center justify-center border transition-colors duration-150",
                                question.type === "radio" ? "rounded-full" : "rounded",
                                on
                                  ? "border-foreground bg-foreground text-background"
                                  : "border-border bg-background text-transparent"
                              )}
                            >
                              {question.type === "radio" ? (
                                <span
                                  className="size-1.5 rounded-full bg-background transition-transform duration-150"
                                  style={{ transform: on ? "scale(1)" : "scale(0)" }}
                                />
                              ) : (
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
                                  <path d="M20 6L9 17l-5-5" />
                                </svg>
                              )}
                            </span>
                            <span
                              className="text-sm leading-5"
                            >
                              {option}
                            </span>
                          </button>
                        )
                      })}
                      <label
                        data-menu-row
                        className={cn(
                          "relative z-10 flex min-h-10 items-center rounded-lg border border-input bg-input/30 px-3 transition-colors focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30",
                          question.options.length > 0 && "mt-1"
                        )}
                      >
                        <input
                          value={custom[qIdx] ?? ""}
                          tabIndex={active ? 0 : -1}
                          onChange={(event) => {
                            if (!active) return
                            setCustom((current) => {
                              const updated = { ...current, [qIdx]: event.target.value }
                              customRef.current = updated
                              return updated
                            })
                            if (question.type === "radio")
                              setAnswers((current) => {
                                const updated = { ...current, [qIdx]: [] }
                                answersRef.current = updated
                                return updated
                              })
                          }}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault()
                              if (hasAnswer && !last) goTo(qi + 1)
                            }
                          }}
                          placeholder={t.customPlaceholder}
                          aria-label="Custom answer"
                          className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
                        />
                      </label>
                    </GlideMenu>
                  </div>
                )
              })}
            </div>
          </div>
        </div>

        {/* footer — step nav (rolling counter) + pill actions */}
        <div className="flex shrink-0 items-center justify-between gap-3 border-t bg-background px-4 py-3">
          <div className="flex items-center gap-1 text-muted-foreground">
            <button
              type="button"
              aria-label="Previous question"
              disabled={qi <= 0}
              onClick={() => goTo(qi - 1)}
              className="flex size-6 items-center justify-center rounded-md transition-colors duration-100 enabled:hover:bg-muted enabled:hover:text-foreground disabled:opacity-30"
            >
              <Ico size={14} path={<path d="M18 15l-6-6-6 6" />} />
            </button>
            <span
              className="inline-flex items-center text-xs font-medium tabular-nums"
              style={{ letterSpacing: "-0.1px", lineHeight: 1 }}
            >
              <RollingDigits value={`${qi + 1} / ${questions.length}`} />
            </span>
            <button
              type="button"
              aria-label="Next question"
              disabled={last}
              onClick={() => goTo(qi + 1)}
              className="flex size-6 items-center justify-center rounded-md transition-colors duration-100 enabled:hover:bg-muted enabled:hover:text-foreground disabled:opacity-30"
            >
              <Ico size={14} path={<path d="M6 9l6 6 6-6" />} />
            </button>
          </div>

          <div className="-mr-0.5 flex items-center gap-1.5">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => (last ? setOpen(false) : goTo(qi + 1))}
            >
              {t.skip}
            </Button>
            <Button size="sm" disabled={!hasAnswer} onClick={advance}>
              {last ? t.send : t.continue}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

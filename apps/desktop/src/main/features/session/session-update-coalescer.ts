export interface SessionUpdateCoalescerOptions<TState, TSource> {
  /** Window length in milliseconds. The first enqueue opens the window; later enqueues do not reset it. */
  delayMs: number
  deliver(state: TState, source: TSource): void
}

export interface SessionUpdateCoalescer<TState, TSource> {
  /** Record the latest state and open the window if none is pending. */
  queue(state: TState, source: TSource): void
  /** Drop the pending state and timer without disabling the coalescer. */
  cancelPending(): void
  /** Deliver the given state immediately, dropping any pending one. */
  flushNow(state: TState, source: TSource): void
  /** Stop delivering entirely. */
  dispose(): void
}

/**
 * Fixed-window throttle for full-snapshot session updates.
 *
 * The first `queue` opens a window; later enqueues within it only replace the
 * pending state. When the window elapses the latest state is delivered once,
 * after which the next enqueue opens a new window. Each delivery is a full
 * snapshot, so dropping intermediate frames loses no data.
 */
export function createSessionUpdateCoalescer<TState, TSource>(
  options: SessionUpdateCoalescerOptions<TState, TSource>
): SessionUpdateCoalescer<TState, TSource> {
  let pending: { state: TState; source: TSource } | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let disposed = false

  const clearTimer = (): void => {
    if (timer === null) return
    clearTimeout(timer)
    timer = null
  }

  const flush = (): void => {
    timer = null
    const next = pending
    pending = null
    if (next === null) return
    options.deliver(next.state, next.source)
  }

  return {
    queue(state, source) {
      if (disposed) return
      pending = { state, source }
      if (timer === null) timer = setTimeout(flush, options.delayMs)
    },
    cancelPending() {
      clearTimer()
      pending = null
    },
    flushNow(state, source) {
      if (disposed) return
      clearTimer()
      pending = null
      options.deliver(state, source)
    },
    dispose() {
      disposed = true
      clearTimer()
      pending = null
    },
  }
}

export interface GoalRefreshScheduler {
  schedule: (sessionId: string) => void
  reset: () => void
  dispose: () => void
}

/**
 * Trailing debounce for per-session goal refreshes. Bursts of session updates
 * collapse into a single refresh per session once the burst settles.
 */
export function createGoalRefreshScheduler(
  refresh: (sessionId: string) => Promise<unknown>,
  delayMs: number
): GoalRefreshScheduler {
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  let disposed = false

  const clearAll = (): void => {
    for (const timer of timers.values()) clearTimeout(timer)
    timers.clear()
  }

  return {
    schedule(sessionId) {
      if (disposed) return
      const existing = timers.get(sessionId)
      if (existing) clearTimeout(existing)
      const timer = setTimeout(() => {
        timers.delete(sessionId)
        void refresh(sessionId)
      }, delayMs)
      timers.set(sessionId, timer)
    },
    reset() {
      clearAll()
    },
    dispose() {
      disposed = true
      clearAll()
    },
  }
}

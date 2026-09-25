import { afterEach, describe, expect, it, vi } from "vitest"

import { createGoalRefreshScheduler } from "./goal-refresh-scheduler"

afterEach(() => {
  vi.useRealTimers()
})

describe("createGoalRefreshScheduler", () => {
  it("collapses a burst into one trailing refresh per session", () => {
    vi.useFakeTimers()
    const refresh = vi.fn(async () => undefined)
    const scheduler = createGoalRefreshScheduler(refresh, 1_000)

    scheduler.schedule("a")
    scheduler.schedule("a")
    scheduler.schedule("a")
    expect(refresh).not.toHaveBeenCalled()

    vi.advanceTimersByTime(999)
    expect(refresh).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(refresh).toHaveBeenCalledWith("a")
  })

  it("tracks sessions independently", () => {
    vi.useFakeTimers()
    const refresh = vi.fn(async () => undefined)
    const scheduler = createGoalRefreshScheduler(refresh, 1_000)

    scheduler.schedule("a")
    scheduler.schedule("b")
    vi.advanceTimersByTime(1_000)

    expect(refresh).toHaveBeenCalledTimes(2)
    expect(refresh).toHaveBeenCalledWith("a")
    expect(refresh).toHaveBeenCalledWith("b")
  })

  it("drops pending refreshes on reset", () => {
    vi.useFakeTimers()
    const refresh = vi.fn(async () => undefined)
    const scheduler = createGoalRefreshScheduler(refresh, 1_000)

    scheduler.schedule("a")
    scheduler.reset()
    vi.advanceTimersByTime(5_000)

    expect(refresh).not.toHaveBeenCalled()

    scheduler.schedule("a")
    vi.advanceTimersByTime(1_000)
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it("ignores schedules after dispose", () => {
    vi.useFakeTimers()
    const refresh = vi.fn(async () => undefined)
    const scheduler = createGoalRefreshScheduler(refresh, 1_000)

    scheduler.dispose()
    scheduler.schedule("a")
    vi.advanceTimersByTime(5_000)

    expect(refresh).not.toHaveBeenCalled()
  })
})

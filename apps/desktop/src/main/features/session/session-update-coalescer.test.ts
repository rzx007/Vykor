import { afterEach, describe, expect, it, vi } from "vitest"

import { createSessionUpdateCoalescer } from "./session-update-coalescer"

type State = { n: number }
type Source = "live" | "reconnecting"

function createCoalescer(delayMs = 50) {
  const deliver = vi.fn<(state: State, source: Source) => void>()
  return { deliver, coalescer: createSessionUpdateCoalescer<State, Source>({ delayMs, deliver }) }
}

afterEach(() => {
  vi.useRealTimers()
})

describe("createSessionUpdateCoalescer", () => {
  it("collapses a burst within one window into a single latest delivery", () => {
    vi.useFakeTimers()
    const { deliver, coalescer } = createCoalescer()

    coalescer.queue({ n: 1 }, "live")
    coalescer.queue({ n: 2 }, "live")
    coalescer.queue({ n: 3 }, "live")
    expect(deliver).not.toHaveBeenCalled()

    vi.advanceTimersByTime(49)
    expect(deliver).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(deliver).toHaveBeenLastCalledWith({ n: 3 }, "live")
  })

  it("keeps the window fixed instead of resetting it on later enqueues", () => {
    vi.useFakeTimers()
    const { deliver, coalescer } = createCoalescer()

    coalescer.queue({ n: 1 }, "live")
    vi.advanceTimersByTime(30)
    coalescer.queue({ n: 2 }, "live")
    vi.advanceTimersByTime(20)

    expect(deliver).toHaveBeenCalledTimes(1)
    expect(deliver).toHaveBeenLastCalledWith({ n: 2 }, "live")
  })

  it("opens a new window for updates queued after a flush", () => {
    vi.useFakeTimers()
    const { deliver, coalescer } = createCoalescer()

    coalescer.queue({ n: 1 }, "live")
    vi.advanceTimersByTime(50)
    coalescer.queue({ n: 2 }, "live")
    vi.advanceTimersByTime(50)

    expect(deliver).toHaveBeenCalledTimes(2)
    expect(deliver).toHaveBeenLastCalledWith({ n: 2 }, "live")
  })

  it("flushes the requested state immediately and drops the pending one", () => {
    vi.useFakeTimers()
    const { deliver, coalescer } = createCoalescer()

    coalescer.queue({ n: 1 }, "live")
    coalescer.flushNow({ n: 9 }, "reconnecting")

    expect(deliver).toHaveBeenCalledTimes(1)
    expect(deliver).toHaveBeenLastCalledWith({ n: 9 }, "reconnecting")

    vi.advanceTimersByTime(1_000)
    expect(deliver).toHaveBeenCalledTimes(1)
  })

  it("stays reusable after cancelPending", () => {
    vi.useFakeTimers()
    const { deliver, coalescer } = createCoalescer()

    coalescer.queue({ n: 1 }, "live")
    coalescer.cancelPending()
    vi.advanceTimersByTime(1_000)
    expect(deliver).not.toHaveBeenCalled()

    coalescer.queue({ n: 2 }, "live")
    vi.advanceTimersByTime(50)
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(deliver).toHaveBeenLastCalledWith({ n: 2 }, "live")
  })

  it("stops delivering after dispose", () => {
    vi.useFakeTimers()
    const { deliver, coalescer } = createCoalescer()

    coalescer.queue({ n: 1 }, "live")
    coalescer.dispose()
    vi.advanceTimersByTime(1_000)
    expect(deliver).not.toHaveBeenCalled()

    coalescer.queue({ n: 2 }, "live")
    coalescer.flushNow({ n: 3 }, "reconnecting")
    vi.advanceTimersByTime(1_000)
    expect(deliver).not.toHaveBeenCalled()
  })
})

import { describe, expect, it, vi } from "vitest"

import { RunStallWatchdog, type RunStallWatchdogOptions } from "../run-stall-watchdog"

function watchdog(
  overrides: Partial<RunStallWatchdogOptions> = {},
): { watchdog: RunStallWatchdog; stalls: string[]; advance: (ms: number) => void } {
  let now = 0
  const stalls: string[] = []
  const instance = new RunStallWatchdog({
    runId: "run-1",
    sessionId: "s1",
    staleMs: 100,
    intervalMs: 10,
    now: () => now,
    readActivity: () => ({ runUpdatedAt: 0, taskUpdatedAt: 0 }),
    hasPendingPermission: () => false,
    hasRunningChildTask: () => false,
    hasRunningTool: () => false,
    onStall: () => stalls.push("stall"),
    ...overrides,
  })
  return { watchdog: instance, stalls, advance: (ms) => { now += ms } }
}

describe("RunStallWatchdog", () => {
  it("fires once when there is no activity past the threshold", () => {
    const { watchdog: instance, stalls, advance } = watchdog()

    advance(99)
    instance.check()
    expect(stalls).toEqual([])

    advance(2)
    instance.check()
    expect(stalls).toEqual(["stall"])

    advance(1_000)
    instance.check()
    expect(stalls).toEqual(["stall"])
  })

  it("treats run or task updates as progress", () => {
    let runUpdatedAt = 0
    const { watchdog: instance, stalls, advance } = watchdog({
      readActivity: () => ({ runUpdatedAt, taskUpdatedAt: 0 }),
    })

    advance(150)
    runUpdatedAt = 150
    instance.check()
    expect(stalls).toEqual([])

    advance(50)
    instance.check()
    expect(stalls).toEqual([])

    advance(60)
    instance.check()
    expect(stalls).toEqual(["stall"])
  })

  it("logs and stays alive when reading activity throws", () => {
    const log = vi.fn()
    const { watchdog: instance, advance } = watchdog({
      readActivity: () => {
        throw new Error("activity boom")
      },
      log,
    })

    advance(1_000)
    expect(() => instance.check()).not.toThrow()
    expect(log).toHaveBeenCalledWith(expect.stringContaining("activity boom"))
  })

  it("does not fire while a permission request is pending", () => {
    const { watchdog: instance, stalls, advance } = watchdog({
      hasPendingPermission: () => true,
    })

    advance(1_000)
    instance.check()
    expect(stalls).toEqual([])
  })

  it("does not fire while a child task is running", () => {
    const { watchdog: instance, stalls, advance } = watchdog({
      hasRunningChildTask: () => true,
    })

    advance(1_000)
    instance.check()
    expect(stalls).toEqual([])
  })

  it("does not fire while a tool is running, then fires once it stops", () => {
    let runningTool = true
    const { watchdog: instance, stalls, advance } = watchdog({
      hasRunningTool: () => runningTool,
    })

    advance(1_000)
    instance.check()
    expect(stalls).toEqual([])

    runningTool = false
    advance(1_000)
    instance.check()
    expect(stalls).toEqual(["stall"])
  })

  it("skips the stall while a bounded model retry deadline is still in the future, then fires after it", () => {
    let retryDeadline = 5_000
    const { watchdog: instance, stalls, advance } = watchdog({
      readModelRetryDeadline: () => retryDeadline,
    })

    advance(1_000)
    instance.check()
    expect(stalls).toEqual([])

    advance(1_000)
    instance.check()
    expect(stalls).toEqual([])

    retryDeadline = 2_000
    advance(1_000)
    instance.check()
    expect(stalls).toEqual(["stall"])
  })

  it("ignores a malformed retry deadline", () => {
    const { watchdog: instance, stalls, advance } = watchdog({
      readModelRetryDeadline: () => Number.NaN,
    })

    advance(1_000)
    instance.check()
    expect(stalls).toEqual(["stall"])
  })

  it("schedules and clears the interval", () => {
    const handle = { unref: vi.fn() } as unknown as ReturnType<typeof setInterval>
    const setIntervalSpy = vi.fn(() => handle)
    const clearIntervalSpy = vi.fn()
    const { watchdog: instance } = watchdog({
      setInterval: setIntervalSpy,
      clearInterval: clearIntervalSpy,
    })

    instance.start()
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 10)

    instance.dispose()
    expect(clearIntervalSpy).toHaveBeenCalledWith(handle)

    instance.check()
    expect(setIntervalSpy).toHaveBeenCalledTimes(1)
  })
})

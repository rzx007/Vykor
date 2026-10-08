// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"

import { beginPanelToggleTransition } from "./panel-toggle-transition"

afterEach(() => {
  vi.useRealTimers()
})

describe("beginPanelToggleTransition", () => {
  it("sets the animating attribute and removes it after the transition window", () => {
    vi.useFakeTimers()
    const group = document.createElement("div")

    beginPanelToggleTransition(group)

    expect(group.getAttribute("data-panel-animating")).toBe("true")
    vi.advanceTimersByTime(240)
    expect(group.hasAttribute("data-panel-animating")).toBe(false)
  })

  it("runs a completion callback after the transition window", () => {
    vi.useFakeTimers()
    const group = document.createElement("div")
    const onComplete = vi.fn()

    beginPanelToggleTransition(group, onComplete)

    expect(onComplete).not.toHaveBeenCalled()
    vi.advanceTimersByTime(240)
    expect(onComplete).toHaveBeenCalledOnce()
  })

  it("cancel removes the attribute immediately, clears the timer, and is idempotent", () => {
    vi.useFakeTimers()
    const group = document.createElement("div")

    const cancel = beginPanelToggleTransition(group)
    cancel()

    expect(group.hasAttribute("data-panel-animating")).toBe(false)
    // Advancing past the original window must not resurrect or re-touch the attribute.
    vi.advanceTimersByTime(240)
    expect(group.hasAttribute("data-panel-animating")).toBe(false)
    expect(() => cancel()).not.toThrow()
  })

  it("re-entrant begin cancels the previous transition so it cannot strip the new one early", () => {
    vi.useFakeTimers()
    const group = document.createElement("div")

    beginPanelToggleTransition(group)
    vi.advanceTimersByTime(200)
    beginPanelToggleTransition(group)

    // 240ms since the first begin, but only 40ms since the second: still animating.
    vi.advanceTimersByTime(40)
    expect(group.getAttribute("data-panel-animating")).toBe("true")

    vi.advanceTimersByTime(200)
    expect(group.hasAttribute("data-panel-animating")).toBe(false)
  })

  it("an old cancel does not touch an element owned by a newer transition", () => {
    vi.useFakeTimers()
    const group = document.createElement("div")

    const firstCancel = beginPanelToggleTransition(group)
    beginPanelToggleTransition(group)

    firstCancel()
    expect(group.getAttribute("data-panel-animating")).toBe("true")
  })

  it("is a no-op for a missing element", () => {
    expect(() => beginPanelToggleTransition(null)()).not.toThrow()
  })
})

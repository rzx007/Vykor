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

  it("cancel removes the attribute immediately and is idempotent", () => {
    vi.useFakeTimers()
    const group = document.createElement("div")

    const cancel = beginPanelToggleTransition(group)
    cancel()

    expect(group.hasAttribute("data-panel-animating")).toBe(false)
    expect(() => cancel()).not.toThrow()
  })

  it("is a no-op for a missing element", () => {
    expect(() => beginPanelToggleTransition(null)()).not.toThrow()
  })
})

// @vitest-environment jsdom

import { act, StrictMode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { AoraAvatar } from "../aora-avatar"
import { mountAoraAvatar } from "../aora-runtime"

describe("aora avatar lifecycle", () => {
  let container: HTMLDivElement
  let root: Root | undefined
  let dispose: (() => void) | undefined

  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
    document.documentElement.dataset.reducedMotion = "true"
    container = document.createElement("div")
    document.body.appendChild(container)
  })

  afterEach(async () => {
    if (root) await act(async () => root?.unmount())
    dispose?.()
    root = undefined
    dispose = undefined
    vi.runOnlyPendingTimers()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    delete document.documentElement.dataset.reducedMotion
    Reflect.deleteProperty(document, "visibilityState")
    container.remove()
  })

  it("keeps one real SVG through StrictMode and replaces it only when the identity changes", async () => {
    root = createRoot(container)
    const render = async (name: string): Promise<void> => {
      await act(async () =>
        root!.render(
          <StrictMode>
            <AoraAvatar name={name} size={64} />
          </StrictMode>
        )
      )
    }

    await render("first")
    await vi.waitFor(() => expect(container.querySelectorAll("svg")).toHaveLength(1))
    const first = container.querySelector("svg")!
    await render("first")
    expect(container.querySelector("svg")).toBe(first)

    await render("second")
    expect(container.querySelectorAll("svg")).toHaveLength(1)
    expect(container.querySelector("svg")).not.toBe(first)
    expect(first.isConnected).toBe(false)
  })

  it("does not mount an SVG if its owner disappears before the engine finishes loading", async () => {
    root = createRoot(container)
    act(() => root!.render(<AoraAvatar name="removed" size={100} />))
    const detachedHost = container.querySelector("span")!
    expect(detachedHost).not.toBeNull()
    act(() => root!.unmount())
    root = undefined
    await vi.dynamicImportSettled()
    expect(detachedHost.querySelector("svg")).toBeNull()
    expect(container.childElementCount).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("pauses real animation for reduced motion and destroys the SVG on cleanup", async () => {
    dispose = mountAoraAvatar(container, "motion", 100)
    const staticFrame = container.innerHTML
    expect(container.querySelectorAll("svg")).toHaveLength(1)
    vi.advanceTimersByTime(1000)
    expect(container.innerHTML).toBe(staticFrame)
    expect(vi.getTimerCount()).toBe(0)

    document.documentElement.dataset.reducedMotion = "false"
    await Promise.resolve()
    vi.advanceTimersByTime(64)
    expect(container.innerHTML).not.toBe(staticFrame)

    document.documentElement.dataset.reducedMotion = "true"
    await Promise.resolve()
    vi.advanceTimersByTime(32)
    const pausedFrame = container.innerHTML
    vi.advanceTimersByTime(1000)
    expect(container.innerHTML).toBe(pausedFrame)
    expect(vi.getTimerCount()).toBe(0)

    dispose()
    dispose = undefined
    expect(container.childElementCount).toBe(0)
  })

  it("pauses while the document is hidden and resumes when it becomes visible", async () => {
    document.documentElement.dataset.reducedMotion = "false"
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" })
    dispose = mountAoraAvatar(container, "visibility", 64)
    vi.advanceTimersByTime(64)
    const hiddenFrame = container.innerHTML
    vi.advanceTimersByTime(1000)
    expect(container.innerHTML).toBe(hiddenFrame)
    expect(vi.getTimerCount()).toBe(0)

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" })
    document.dispatchEvent(new Event("visibilitychange"))
    vi.advanceTimersByTime(64)
    expect(container.innerHTML).not.toBe(hiddenFrame)
    dispose()
    dispose = undefined
    vi.advanceTimersByTime(32)
    expect(vi.getTimerCount()).toBe(0)
  })
})

// @vitest-environment jsdom
import { StrictMode } from "react"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const sessionEvents = vi.hoisted(() => ({
  active: 0,
  attach: vi.fn(() => {
    sessionEvents.active += 1
    return () => {
      sessionEvents.active -= 1
    }
  }),
}))

vi.mock("@renderer/stores/desktop-session", () => ({
  attachDesktopSessionEvents: sessionEvents.attach,
}))

import { DesktopSessionEventBridge } from "./desktop-session-event-bridge"
import { shouldAttachDesktopSessionEvents } from "./desktop-session-event-bridge-path"

describe("DesktopSessionEventBridge", () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    ;(
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true
    sessionEvents.active = 0
    sessionEvents.attach.mockClear()
    container = document.createElement("div")
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    expect(sessionEvents.active).toBe(0)
    delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT
  })

  it("keeps one listener set while enabled content rerenders", () => {
    act(() => root.render(<DesktopSessionEventBridge enabled />))
    act(() => root.render(<DesktopSessionEventBridge enabled />))
    expect(sessionEvents.attach).toHaveBeenCalledTimes(1)
    expect(sessionEvents.active).toBe(1)
  })

  it("cleans up when disabled", () => {
    act(() => root.render(<DesktopSessionEventBridge enabled />))
    act(() => root.render(<DesktopSessionEventBridge enabled={false} />))
    expect(sessionEvents.active).toBe(0)
  })

  it("leaves one effective listener set under StrictMode", () => {
    act(() =>
      root.render(
        <StrictMode>
          <DesktopSessionEventBridge enabled />
        </StrictMode>
      )
    )
    expect(sessionEvents.active).toBe(1)
  })

  it("excludes only the pet window", () => {
    expect(shouldAttachDesktopSessionEvents("/pet")).toBe(false)
    expect(shouldAttachDesktopSessionEvents("/")).toBe(true)
    expect(shouldAttachDesktopSessionEvents("/settings/general")).toBe(true)
  })
})

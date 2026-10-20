// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { DesktopDaemonAutoStartSnapshot } from "@shared/settings-types"
import { DaemonAutoStartControl } from "../daemon-autostart-control"

const disabled: DesktopDaemonAutoStartSnapshot = {
  configured: false,
  serviceState: "not-installed",
  enabled: false,
  onboardingState: "dismissed",
  showOnboarding: false,
}

describe("DaemonAutoStartControl", () => {
  let container: HTMLDivElement
  let root: Root
  const snapshot = vi.fn(async () => disabled)
  const enable = vi.fn(async () => ({
    ...disabled,
    configured: true,
    serviceState: "running" as const,
    enabled: true,
  }))

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
    Object.defineProperty(window, "desktop", {
      configurable: true,
      value: {
        daemonAutoStart: { snapshot, enable, disable: vi.fn(), dismissOnboarding: vi.fn() },
      },
    })
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.clearAllMocks()
  })

  it("loads actual state and refreshes when the window regains focus", async () => {
    act(() => root.render(<DaemonAutoStartControl />))
    await act(async () => undefined)
    expect(snapshot).toHaveBeenCalledOnce()
    await act(async () => window.dispatchEvent(new Event("focus")))
    expect(snapshot).toHaveBeenCalledTimes(2)
  })
})

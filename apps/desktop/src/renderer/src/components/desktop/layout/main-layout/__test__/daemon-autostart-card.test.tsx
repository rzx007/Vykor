// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { DesktopDaemonAutoStartSnapshot } from "@shared/settings-types"
import { DaemonAutoStartCard } from "../daemon-autostart-card"

const pending: DesktopDaemonAutoStartSnapshot = {
  configured: false,
  serviceState: "not-installed",
  enabled: false,
  onboardingState: "pending",
  showOnboarding: true,
}
const hidden: DesktopDaemonAutoStartSnapshot = {
  ...pending,
  onboardingState: "dismissed",
  showOnboarding: false,
}

describe("DaemonAutoStartCard", () => {
  let container: HTMLDivElement
  let root: Root
  const snapshot = vi.fn(async () => pending)
  const enable = vi.fn(async () => ({ ...pending, enabled: true, showOnboarding: false }))
  const dismissOnboarding = vi.fn(async () => hidden)

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
    Object.defineProperty(window, "desktop", {
      configurable: true,
      value: { daemonAutoStart: { snapshot, enable, disable: vi.fn(), dismissOnboarding } },
    })
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.clearAllMocks()
  })

  it("waits for the snapshot before showing the quiet onboarding card", async () => {
    act(() => root.render(<DaemonAutoStartCard />))
    expect(container.textContent).toBe("")
    await act(async () => undefined)
    expect(container.textContent).toContain("保持后台运行")
    expect(container.textContent).toContain("暂不开启")
  })

  it("disappears permanently when the user dismisses it", async () => {
    act(() => root.render(<DaemonAutoStartCard />))
    await act(async () => undefined)
    const button = [...container.querySelectorAll("button")].find(
      (item) => item.textContent === "暂不开启"
    )
    await act(async () => button?.click())
    expect(dismissOnboarding).toHaveBeenCalledOnce()
    expect(container.textContent).toBe("")
  })
})

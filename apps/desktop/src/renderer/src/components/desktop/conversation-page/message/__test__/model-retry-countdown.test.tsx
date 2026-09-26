// @vitest-environment jsdom
import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import { expect, it, vi } from "vitest"
import { ModelRetryNotice } from "../model-retry-notice"

it("updates without incoming snapshots and cleans up on unmount", () => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  const globals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  globals.IS_REACT_ACT_ENVIRONMENT = true
  const container = document.createElement("div")
  const root = createRoot(container)
  try {
    act(() => root.render(createElement(ModelRetryNotice, { retry: {
      generationId: "g", attempt: 1, retryNumber: 1, maxRetries: 5, reason: "network",
      nextRetryAt: 2000, recoveryDeadlineAt: 10000,
    } })))
    expect(container.textContent).toContain("2 秒后")
    act(() => vi.advanceTimersByTime(2000))
    expect(container.textContent).toContain("正在重新连接")
  } finally {
    act(() => root.unmount())
    expect(vi.getTimerCount()).toBe(0)
    delete globals.IS_REACT_ACT_ENVIRONMENT
    vi.useRealTimers()
  }
})

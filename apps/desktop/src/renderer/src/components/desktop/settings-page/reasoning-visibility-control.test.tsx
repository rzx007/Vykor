// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

import { ReasoningVisibilityControl } from "./settings-content"

let container: HTMLDivElement
let root: Root
const snapshot = vi.fn(async () => ({ showReasoning: true }))
const updateReasoningVisibility = vi.fn(async ({ showReasoning }: { showReasoning: boolean }) => ({ showReasoning }))

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
  Object.defineProperty(window, "desktop", {
    configurable: true,
    value: { settings: { snapshot, updateReasoningVisibility } },
  })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.clearAllMocks()
})

it("loads the reasoning setting and saves a switch change", async () => {
  act(() => root.render(<ReasoningVisibilityControl />))
  await act(async () => undefined)
  const control = container.querySelector('[role="switch"]') as HTMLButtonElement
  expect(control.getAttribute("aria-checked")).toBe("true")
  await act(async () => control.click())
  expect(updateReasoningVisibility).toHaveBeenCalledWith({ showReasoning: false })
  expect(control.getAttribute("aria-checked")).toBe("false")
})

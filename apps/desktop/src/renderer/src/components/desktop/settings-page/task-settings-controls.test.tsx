// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { TaskLimitControl } from "./task-settings-controls"
let container: HTMLDivElement, root: Root
const limits = vi.fn(async () => ({ maxTurns: 50, editable: true, reason: null }))
const updateLimits = vi.fn(async (input: { maxTurns: number }) => ({
  maxTurns: input.maxTurns,
  editable: true,
  reason: null,
}))
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  limits.mockReset().mockResolvedValue({ maxTurns: 50, editable: true, reason: null })
  updateLimits.mockClear()
  Object.defineProperty(window, "desktop", {
    configurable: true,
    value: { configurationSettings: { limits, updateLimits } },
  })
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})
it("allows the settings page to remain usable before a preload restart", async () => {
  Object.defineProperty(window, "desktop", {
    configurable: true,
    value: { configurationSettings: {} },
  })
  await act(async () => root.render(<TaskLimitControl />))
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("重启应用")
  expect(container.querySelector<HTMLInputElement>("input")?.disabled).toBe(true)
})
it("saves the chosen limit with its original value", async () => {
  await act(async () => root.render(<TaskLimitControl />))
  const input = container.querySelector<HTMLInputElement>("input")!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "75")
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "保存")!
      .click()
  )
  expect(updateLimits).toHaveBeenCalledWith({ maxTurns: 75, expectedMaxTurns: 50 })
})

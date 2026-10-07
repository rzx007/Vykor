// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type {
  UsageReport,
  UsageSettings as UsagePreferences,
} from "@shared/maintenance-settings-types"
import { UsageSettings } from "./usage-settings"

let container: HTMLDivElement, root: Root, report: UsageReport
const budget = vi.fn(async (input: UsagePreferences["budget"]) => {
  report.settings.budget = {
    enabled: input.enabled,
    tokens: input.tokens,
    amount: input.amount,
    currency: input.currency,
  }
  return report.settings
})
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  report = {
    scannedAt: 1,
    requests: [],
    warnings: [],
    options: { projects: [], providers: [], models: [] },
    totals: {
      requests: 0,
      unknown: 0,
      partial: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheCreation: 0,
      costs: {},
    },
    settings: {
      version: 1,
      prices: [],
      budget: { enabled: false, tokens: 5000, amount: 10, currency: "USD" },
    },
  }
  budget.mockClear()
  Object.defineProperty(window, "desktop", {
    configurable: true,
    value: { maintenance: { usage: async () => structuredClone(report), budget } },
  })
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root.render(<UsageSettings />))
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})
async function click(text: string) {
  const button = [...container.querySelectorAll("button")].find((item) => item.textContent === text)
  expect(button).toBeDefined()
  await act(async () => button!.click())
}
it("does not show disabled budget fields or enable a reminder until saving", async () => {
  expect(container.querySelector("#usage-token-budget")).toBeNull()
  await click("设置并启用")
  expect(container.querySelector<HTMLInputElement>("#usage-token-budget")?.value).toBe("5000")
  expect(budget).not.toHaveBeenCalled()
  await click("取消设置")
  expect(container.querySelector("#usage-token-budget")).toBeNull()
  expect(budget).not.toHaveBeenCalled()
})
it("preserves saved thresholds when enabling and disabling reminders", async () => {
  await click("设置并启用")
  await click("启用并保存")
  expect(budget).toHaveBeenLastCalledWith({
    enabled: true,
    tokens: 5000,
    amount: 10,
    currency: "USD",
    expected: { enabled: false, tokens: 5000, amount: 10, currency: "USD" },
  })
  await click("关闭提醒")
  expect(report.settings.budget.enabled).toBe(false)
  expect(report.settings.budget.tokens).toBe(5000)
  expect(report.settings.budget.amount).toBe(10)
  expect(container.querySelector("#usage-token-budget")).toBeNull()
})

// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type {
  UsageReport,
  UsageFilter,
  UsageSettings as UsagePreferences,
} from "@shared/maintenance-settings-types"
import { UsageSettings } from "../usage-settings"

let container: HTMLDivElement, root: Root, report: UsageReport
const usage = vi.fn<(filter: UsageFilter) => Promise<UsageReport>>()
const exportUsage = vi.fn<(filter: UsageFilter, format: "csv" | "json") => Promise<string | null>>(
  async () => null
)
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
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe = vi.fn()
      unobserve = vi.fn()
      disconnect = vi.fn()
    }
  )
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("prefers-reduced-motion"),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
  }))
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
  usage.mockReset().mockImplementation(async () => structuredClone(report))
  exportUsage.mockClear()
  Object.defineProperty(window, "desktop", {
    configurable: true,
    value: { maintenance: { usage, budget, exportUsage } },
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
  const button = [...container.querySelectorAll("button")].find((item) => {
    const content = item.cloneNode(true) as HTMLElement
    content.querySelectorAll('[aria-hidden="true"], .sr-only').forEach((node) => node.remove())
    return content.textContent?.trim() === text
  })
  expect(button).toBeDefined()
  await act(async () => button!.click())
}

async function openBudget() {
  const trigger = container.querySelector<HTMLButtonElement>(
    '#usage-budget [data-slot="collapsible-trigger"]'
  )!
  if (trigger.getAttribute("aria-expanded") === "false") await act(async () => trigger.click())
}

it("links time tabs to the selected data panel", async () => {
  const list = container.querySelector('[role="tablist"][aria-label="时间范围"]')!
  const selected = list.querySelector('[role="tab"][aria-selected="true"]')!
  const panel = document.getElementById(selected.getAttribute("aria-controls")!)!
  expect(panel.getAttribute("role")).toBe("tabpanel")
  expect(panel.getAttribute("aria-labelledby")).toBe(selected.id)
  expect(panel.contains(container.querySelector("#usage-summary"))).toBe(true)
  await click("今天")
  const current = list.querySelector('[role="tab"][aria-selected="true"]')!
  expect(current.textContent).toContain("今天")
  expect(document.getElementById(current.getAttribute("aria-controls")!)?.hidden).toBe(false)
})
it("does not show disabled budget fields or enable a reminder until saving", async () => {
  expect(container.querySelector("#usage-token-budget")).toBeNull()
  await openBudget()
  await click("设置并启用")
  expect(container.querySelector<HTMLInputElement>("#usage-token-budget")?.value).toBe("5000")
  expect(budget).not.toHaveBeenCalled()
  await click("取消设置")
  expect(container.querySelector("#usage-token-budget")).toBeNull()
  expect(budget).not.toHaveBeenCalled()
})
it("preserves the token threshold and disables the hidden old cost threshold", async () => {
  await openBudget()
  await click("设置并启用")
  await click("启用并保存")
  expect(budget).toHaveBeenLastCalledWith({
    enabled: true,
    tokens: 5000,
    amount: null,
    currency: "USD",
    expected: { enabled: false, tokens: 5000, amount: 10, currency: "USD" },
  })
  await click("关闭提醒")
  expect(report.settings.budget.enabled).toBe(false)
  expect(report.settings.budget.tokens).toBe(5000)
  expect(report.settings.budget.amount).toBeNull()
  expect(container.querySelector('[aria-label="本月 Token 提醒说明"]')).not.toBeNull()
  expect(container.querySelector("#usage-token-budget")).toBeNull()
})

it("distinguishes measured zero from missing token usage in the charts", async () => {
  report.requests = [
    {
      id: "zero",
      time: Date.now() - 1000,
      project: "project",
      sessionId: "session",
      runId: "run",
      provider: "provider",
      model: "model",
      status: "completed",
      completeness: "complete",
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      cost: null,
    },
  ]
  await click("刷新")
  expect(container.querySelector("#usage-distribution")?.textContent).toContain("已知 Token 为 0")
  expect(container.querySelector("#usage-distribution")?.textContent).not.toContain(
    "未提供 Token 用量"
  )
  expect(container.querySelector("#usage-trend")?.textContent).toContain("已知 Token 为 0")
})

it("makes an active legacy amount reminder visible until the user replaces or disables it", async () => {
  report.settings.budget = { enabled: true, tokens: null, amount: 10, currency: "USD" }
  await click("刷新")
  const reminder = container.querySelector("#usage-budget")!
  expect(reminder.querySelector('[data-slot="collapsible-trigger"]')?.textContent).toContain(
    "旧版提醒已启用"
  )
  await openBudget()
  expect(reminder.textContent).toContain("旧版金额提醒仍可能发送通知")
  await click("改为 Token 提醒")
  expect(container.querySelector<HTMLInputElement>("#usage-token-budget")?.value).toBe("")
  expect(budget).not.toHaveBeenCalled()
  await click("取消设置")
  await click("关闭提醒")
  expect(report.settings.budget.enabled).toBe(false)
})

it("shows real token trends and model shares without cost controls", async () => {
  const time = Date.now() - 1000
  report.requests = [
    {
      id: "request",
      time,
      project: "project",
      sessionId: "session",
      runId: "run",
      provider: "provider",
      model: "test-model",
      status: "completed",
      completeness: "complete",
      inputTokens: 12000,
      outputTokens: 500,
      cacheReadTokens: null,
      cacheCreationTokens: null,
      cost: null,
    },
  ]
  await click("刷新")
  const summary = container.querySelector("#usage-summary")!
  expect(summary.textContent).toContain("12.5K")
  expect(container.querySelector('[role="img"][aria-label="模型Token占比"]')).not.toBeNull()
  expect(container.querySelector("#usage-distribution")?.textContent).toContain("test-model")
  expect(container.textContent).not.toMatch(/费用|单价|币种|模型估算价格/)
  expect(container.querySelectorAll("[data-usage-bar]").length).toBe(7)
})

it("shows missing token and cache values as unknown rather than zero", async () => {
  report.requests = [
    {
      id: "unknown",
      time: Date.now() - 1000,
      project: "project",
      sessionId: "session",
      runId: "run",
      provider: "provider",
      model: "model",
      status: "unfinished",
      completeness: "unknown",
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheCreationTokens: null,
      cost: null,
    },
  ]
  await click("刷新")
  expect(
    [...container.querySelectorAll("#usage-summary dd")].map((item) =>
      item.getAttribute("aria-label")
    )
  ).toEqual(["未知", "未知", "未知", "1"])
  expect(container.querySelector("#usage-details tbody")?.textContent).toContain("等待回报")
  expect(container.querySelector("#usage-distribution")?.textContent).toContain("未提供 Token 用量")
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>(
        '[role="tablist"][aria-label="趋势统计指标"] [role="tab"][data-tabs-value="requests"]'
      )!
      .click()
  )
  expect(container.querySelector('[role="img"][aria-label="模型条记录占比"]')).not.toBeNull()
})

it("reveals clearly named exports and uses the displayed filter window and format", async () => {
  expect(container.querySelector('[title="导出 CSV"]')).toBeNull()
  expect(container.querySelector('[title="导出 JSON"]')).toBeNull()
  const toggle = container.querySelector<HTMLButtonElement>('[aria-label="更多用量操作"]')!
  expect(toggle.getAttribute("aria-expanded")).toBe("false")
  await act(async () => toggle.click())
  expect(toggle.getAttribute("aria-expanded")).toBe("true")
  expect(document.getElementById(toggle.getAttribute("aria-controls")!)).not.toBeNull()
  await click("导出 CSV")
  expect(exportUsage).toHaveBeenLastCalledWith(usage.mock.calls.at(-1)![0], "csv")
  await click("导出 JSON")
  expect(exportUsage).toHaveBeenLastCalledWith(usage.mock.calls.at(-1)![0], "json")
  await act(async () => toggle.click())
  expect(toggle.getAttribute("aria-expanded")).toBe("false")
  expect(toggle.getAttribute("aria-label")).toBe("更多用量操作")
})

it("retains the previous data when refresh fails and supports retry", async () => {
  usage.mockRejectedValueOnce(new Error("暂时无法连接"))
  await click("刷新")
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("仍显示上次读取结果")
  expect(container.querySelector("#usage-summary")).not.toBeNull()
  await click("重试")
  expect(container.querySelector('[role="alert"]')).toBeNull()
})

it("does not let an older range response replace the latest selection", async () => {
  let resolveOlder!: (value: UsageReport) => void
  usage.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveOlder = resolve
      })
  )
  await click("今天")
  await click("最近 30 天")
  const afterLatest = container.querySelector("#usage-summary")?.textContent
  await act(async () =>
    resolveOlder({
      ...report,
      requests: [
        {
          id: "old",
          time: Date.now() - 1000,
          project: "project",
          sessionId: "session",
          runId: "run",
          provider: "provider",
          model: "old",
          status: "completed",
          completeness: "complete",
          inputTokens: 999,
          outputTokens: 1,
          cacheReadTokens: null,
          cacheCreationTokens: null,
          cost: null,
        },
      ],
    })
  )
  expect(container.querySelector("#usage-summary")?.textContent).toBe(afterLatest)
  expect(container.querySelector("#usage-distribution")?.textContent).not.toContain("old")
})

it("supports keyboard inspection and paginates the complete filtered detail list", async () => {
  report.requests = Array.from({ length: 25 }, (_, index) => ({
    id: String(index),
    time: Date.now() - index * 1000 - 1000,
    project: "project",
    sessionId: "session",
    runId: "run",
    provider: "provider",
    model: `model-${index}`,
    status: "completed",
    completeness: "complete",
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: null,
    cacheCreationTokens: null,
    cost: null,
  }))
  await click("刷新")
  const bars = container.querySelectorAll<HTMLButtonElement>("[data-usage-bar]")
  await act(async () => {
    bars[0].focus()
    bars[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }))
  })
  expect(document.activeElement).toBe(bars[1])
  expect(container.querySelectorAll("#usage-details tbody tr")).toHaveLength(10)
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="下一页请求"]')!.click()
  )
  expect(container.querySelector("#usage-details tbody")?.textContent).toContain("model-10")
  expect(container.querySelector("#usage-details tbody")?.textContent).not.toContain("model-0")
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="下一页请求"]')!.click()
  )
  expect(container.querySelectorAll("#usage-details tbody tr")).toHaveLength(5)
})

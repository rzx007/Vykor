// @vitest-environment jsdom
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { SettingsContent } from "../../settings-content"

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...await importOriginal<typeof import("@tanstack/react-router")>(),
  useRouterState: () => "",
}))
vi.mock("../../terminal/terminal-settings", () => ({ TerminalSettings: () => null }))

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

it("shows the saved grants and lets users revoke them while control is disabled", async () => {
  const revokeAppGrant = vi.fn(async () => [])
  vi.stubGlobal("desktop", { computer: {
    getSettings: async () => ({ availability: "disabled", enabled: false, alwaysForeground: false }),
    listAppGrants: async () => [{ id: "calc", name: "计算器" }],
    revokeAppGrant,
  } })
  await act(async () => root.render(<SettingsContent selectedSection="电脑控制" />))
  expect(container.textContent).toContain("电脑控制已停用")
  expect(container.querySelector("#computer-app-grants")?.textContent).toBe("始终允许的应用")

  const revoke = container.querySelector<HTMLButtonElement>('[aria-label="撤销 计算器 的访问许可"]')!
  await act(async () => revoke.click())

  expect(revokeAppGrant).toHaveBeenCalledExactlyOnceWith("calc")
  expect(container.querySelector('[aria-label="撤销 计算器 的访问许可"]')).toBeNull()
  expect(container.textContent).toContain("没有已授权的应用")
})

it("keeps the page and saved grants usable with the older preload bridge", async () => {
  vi.stubGlobal("desktop", { computer: {
    isAvailable: async () => true,
    getAvailability: async () => "ready",
    listAppGrants: async () => [{ id: "calc", name: "计算器" }],
    revokeAppGrant: async () => [],
  } })

  await act(async () => root.render(<SettingsContent selectedSection="电脑控制" />))

  expect(container.textContent).toContain("请完整重启 Vykor")
  expect(container.querySelector<HTMLButtonElement>("#computer-enabled")?.disabled).toBe(true)
  expect(container.querySelector<HTMLButtonElement>("#computer-always-foreground")?.disabled).toBe(true)
  const revoke = container.querySelector<HTMLButtonElement>('[aria-label="撤销 计算器 的访问许可"]')!
  expect(revoke.disabled).toBe(false)
  await act(async () => revoke.click())
  expect(container.textContent).toContain("没有已授权的应用")
})

it.each([
  ["ready", "驱动已就绪"],
  ["missing_driver", "驱动不可用"],
  ["unsupported", "当前平台暂不支持"],
])("shows the local status for %s", async (availability, label) => {
  vi.stubGlobal("desktop", { computer: {
    getSettings: async () => ({ availability, enabled: availability !== "unsupported", alwaysForeground: false }),
    listAppGrants: async () => [],
  } })

  await act(async () => root.render(<SettingsContent selectedSection="电脑控制" />))

  expect(container.textContent).toContain(label)
  expect(container.textContent).toContain("按 Esc")
})

it("keeps saved grants visible if the status check fails and keeps the row if revocation fails", async () => {
  vi.stubGlobal("desktop", { computer: {
    getSettings: async () => { throw new Error("检查失败") },
    listAppGrants: async () => [{ id: "calc", name: "计算器" }],
    revokeAppGrant: async () => { throw new Error("撤销失败") },
  } })
  await act(async () => root.render(<SettingsContent selectedSection="电脑控制" />))
  expect(container.textContent).toContain("无法检查本机状态")

  const revoke = container.querySelector<HTMLButtonElement>('[aria-label="撤销 计算器 的访问许可"]')!
  await act(async () => revoke.click())

  expect(container.querySelector('[role="alert"]')?.textContent).toContain("撤销失败")
  expect(revoke.isConnected).toBe(true)
  expect(revoke.disabled).toBe(false)
})

it("reflects confirmed changes to both switches", async () => {
  const getSettings = async () => ({ availability: "disabled", enabled: false, alwaysForeground: false })
  const updateSettings = vi.fn()
    .mockResolvedValueOnce({ availability: "ready", enabled: true, alwaysForeground: false })
    .mockResolvedValueOnce({ availability: "ready", enabled: true, alwaysForeground: true })
  vi.stubGlobal("desktop", { computer: { getSettings, updateSettings, listAppGrants: async () => [] } })
  await act(async () => root.render(<SettingsContent selectedSection="电脑控制" />))
  const enable = container.querySelector<HTMLButtonElement>('#computer-enabled[data-slot="switch"]')!
  const foreground = container.querySelector<HTMLButtonElement>('#computer-always-foreground[data-slot="switch"]')!
  expect(enable?.getAttribute("aria-checked")).toBe("false")
  expect(foreground.disabled).toBe(true)

  await act(async () => enable.click())
  expect(updateSettings).toHaveBeenNthCalledWith(1, { setting: "enabled", value: true })
  expect(enable.getAttribute("aria-checked")).toBe("true")
  expect(foreground.disabled).toBe(false)

  await act(async () => foreground.click())
  expect(updateSettings).toHaveBeenNthCalledWith(2, { setting: "alwaysForeground", value: true })
  expect(foreground.getAttribute("aria-checked")).toBe("true")
})

it("copies each full prompt from an icon-only button", async () => {
  const writeText = vi.fn(async () => {})
  vi.stubGlobal("navigator", Object.assign(Object.create(window.navigator), { clipboard: { writeText } }))
  vi.stubGlobal("desktop", { computer: {
    getSettings: async () => ({ availability: "ready", enabled: true, alwaysForeground: false }),
    listAppGrants: async () => [],
  } })
  await act(async () => root.render(<SettingsContent selectedSection="电脑控制" />))
  const buttons = container.querySelectorAll<HTMLButtonElement>('button[aria-label^="复制"][aria-label$="示例"]')
  expect(buttons).toHaveLength(3)
  for (const button of buttons) {
    expect(button.textContent).toBe("")
    expect(button.querySelector("svg")).not.toBeNull()
    await act(async () => button.click())
  }
  expect(writeText.mock.calls).toEqual([
    ["打开计算器，算一下 7 × 8，并告诉我结果。"],
    ["打开记事本，在空白文档里输入「今天完成了电脑操作测试」，然后读回确认。"],
    ["打开画图，查看当前画布，并把窗口截图发到这条对话里。"],
  ])
})

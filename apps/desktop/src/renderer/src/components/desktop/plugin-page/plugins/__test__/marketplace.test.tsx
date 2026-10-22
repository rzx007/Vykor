// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Marketplace } from "../marketplace"

describe("marketplace browsing", () => {
  let root: Root
  let host: HTMLDivElement
  const entry = {
    sourceId: "custom",
    plugin: {
      id: "demo.plugin",
      name: "demo",
      displayName: "测试插件",
      description: "整理研究资料",
      category: "research",
      version: "2.0.0",
      componentTypes: ["tool"],
      author: { name: "作者" },
    },
    installedVersion: "1.0.0",
    installedSourceId: "custom",
    updateAvailable: true,
    compatible: true,
  }
  const sources = [
    {
      id: "custom",
      name: "团队源",
      url: "https://example.com/index.json",
      enabled: true,
      builtin: false,
    },
    {
      id: "builtin",
      name: "内置源",
      url: "https://example.com/builtin.json",
      enabled: true,
      builtin: true,
    },
  ]
  const api = {
    marketplaceCatalog: vi.fn(),
    marketplacePreview: vi.fn(),
    marketplaceConfirm: vi.fn(),
    marketplaceCancel: vi.fn(),
    marketplaceAddSource: vi.fn(),
    marketplaceSetSourceEnabled: vi.fn(),
    marketplaceRemoveSource: vi.fn(),
    marketplaceOperation: vi.fn(),
    snapshot: vi.fn(),
  }
  beforeEach(() => {
    vi.clearAllMocks()
    ;(
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe = vi.fn()
        unobserve = vi.fn()
        disconnect = vi.fn()
      },
    )
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    }))
    Object.defineProperty(window, "desktop", { configurable: true, value: { plugins: api } })
    api.marketplaceCatalog.mockResolvedValue({ entries: [entry], sources })
    api.marketplacePreview.mockResolvedValue({
      selectionId: "opaque",
      pluginName: "测试插件",
      requestedPermissions: ["network:example.com", "ui:render", "pluginData:write"],
      replacementRequired: true,
      sourceName: "团队源",
      approvalRequired: true,
    })
    api.marketplaceConfirm.mockResolvedValue({
      operationId: "original",
      status: "unknown",
      message: "待检查",
    })
    api.marketplaceCancel.mockResolvedValue(undefined)
    host = document.createElement("div")
    document.body.append(host)
    root = createRoot(host)
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    document.body.innerHTML = ""
    vi.unstubAllGlobals()
  })
  async function render(query = "", refreshRequest = 0): Promise<void> {
    await act(async () =>
      root.render(
        <Marketplace
          query={query}
          refreshRequest={refreshRequest}
          projectPath="D:/project"
          notify={vi.fn()}
        />,
      ),
    )
  }
  async function click(text: string): Promise<void> {
    const button = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === text,
    )
    expect(button).toBeTruthy()
    await act(async () => button!.click())
  }
  it.each([
    { installedSourceId: undefined, label: "关联来源" },
    { installedSourceId: "another-source", label: "更换来源" },
  ])(
    "allows explicit $label for an existing equal-version installation",
    async ({ installedSourceId, label }) => {
      api.marketplaceCatalog.mockResolvedValue({
        entries: [
          { ...entry, installedVersion: "2.0.0", installedSourceId, updateAvailable: false },
        ],
        sources,
      })
      await render()
      await click(label)
      expect(api.marketplacePreview).toHaveBeenCalledWith({
        cwd: "D:/project",
        sourceId: "custom",
        pluginId: "demo.plugin",
        version: "2.0.0",
      })
      expect(api.marketplaceConfirm).not.toHaveBeenCalled()
      expect(document.body.textContent).toContain("替换现有安装")
    },
  )
  it("keeps equal-version same-source installation disabled", async () => {
    api.marketplaceCatalog.mockResolvedValue({
      entries: [{ ...entry, installedVersion: "2.0.0", updateAvailable: false }],
      sources,
    })
    await render()
    const button = [...host.querySelectorAll("button")].find(
      (button) => button.textContent === "已安装",
    )!
    expect(button).toBeTruthy()
    expect(button.disabled).toBe(true)
    expect(api.marketplacePreview).not.toHaveBeenCalled()
  })
  it("browses actual metadata, searches category, and explicitly refreshes cache", async () => {
    await render()
    expect(host.textContent).toContain("作者")
    expect(host.textContent).toContain("已安装 1.0.0")
    await render("missing")
    expect(host.textContent).not.toContain("整理研究资料")
    await render("research", 1)
    expect(host.textContent).toContain("整理研究资料")
    expect(api.marketplaceCatalog).toHaveBeenLastCalledWith({ cwd: "D:/project", refresh: true })
  })
  it("shows real permissions and source replacement before sending only the opaque selection", async () => {
    await render()
    await click("更新")
    expect(document.body.textContent).toContain("替换现有安装")
    expect(document.body.textContent).toContain("example.com")
    expect(document.body.textContent).toContain("显示插件的隔离交互界面")
    expect(document.body.textContent).toContain("工作区导出仍单独确认")
    expect(api.marketplaceConfirm).not.toHaveBeenCalled()
    await click("确认安装")
    expect(api.marketplaceConfirm).toHaveBeenCalledWith({
      cwd: "D:/project",
      selectionId: "opaque",
    })
    api.marketplaceOperation.mockResolvedValue({
      operationId: "original",
      status: "failed",
      message: "来源已禁用",
    })
    await click("检查安装结果")
    expect(api.marketplaceOperation).toHaveBeenCalledWith({
      cwd: "D:/project",
      operationId: "original",
    })
    expect(host.textContent).toContain("来源已禁用")
    expect(api.marketplacePreview).toHaveBeenCalledTimes(1)
  })
  it("manages custom sources independently and keeps builtin removal unavailable", async () => {
    await render()
    await click("管理插件源")
    expect(document.body.textContent).toContain("保留已安装插件及数据")
    expect(
      [...document.querySelectorAll("button")].some(
        (button) => button.textContent === "移除 内置源",
      ),
    ).toBe(false)
    const sourceInput = document.querySelector<HTMLInputElement>('input[aria-label="插件源地址"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        sourceInput,
        "https://new.example.com/index.json",
      )
      sourceInput.dispatchEvent(new Event("input", { bubbles: true }))
    })
    await click("添加插件源")
    expect(api.marketplaceAddSource).toHaveBeenCalledWith({
      url: "https://new.example.com/index.json",
    })
    await click("移除 团队源")
    expect(api.marketplaceRemoveSource).toHaveBeenCalledWith({ sourceId: "custom" })
    const toggle = document.querySelector('[aria-label="禁用 内置源"]') as HTMLButtonElement
    await act(async () => toggle.click())
    expect(api.marketplaceSetSourceEnabled).toHaveBeenCalledWith({
      sourceId: "builtin",
      enabled: false,
    })
  })
})

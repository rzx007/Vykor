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
      icon: "data:image/svg+xml;base64,PHN2Zy8+",
      introduction: "## 研究助手\n\n在这里查看完整介绍。",
      prompts: [{ title: "整理资料", prompt: "为这份资料整理提纲，并保留来源。" }],
      license: "MIT",
      homepage: "https://example.com/plugin",
      requires: { host: ">=1.2.20", node: ">=24.0.0" },
      source: {
        repository: "https://example.com/repository",
        commit: "a".repeat(40),
        path: "plugin",
      },
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
      }
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
  it("uses an already installed plugin example after reopening the marketplace", async () => {
    const plugin = {
      identity: { id: entry.plugin.id, name: "demo", version: "2.0.0" },
      enabled: true, installation: "installed", permissions: { missing: [] },
      runtimeStatus: { state: "ready" },
    }
    api.snapshot.mockResolvedValue({ plugins: [plugin] })
    api.marketplaceCatalog.mockResolvedValue({
      entries: [{ ...entry, installedVersion: "2.0.0", updateAvailable: false }], sources,
    })
    const onUse = vi.fn(async () => undefined)
    await act(async () => root.render(
      <Marketplace query="" projectPath="D:/project" refreshRequest={0} notify={vi.fn()} onUse={onUse} />
    ))
    await click("查看 测试插件 详情")
    await click("使用示例：整理资料")
    expect(onUse).toHaveBeenCalledWith(plugin, entry.plugin.prompts[0]!.prompt)
    expect(api.marketplaceConfirm).not.toHaveBeenCalled()
  })
  async function render(query = "", refreshRequest = 0): Promise<void> {
    await act(async () =>
      root.render(
        <Marketplace
          query={query}
          refreshRequest={refreshRequest}
          projectPath="D:/project"
          notify={vi.fn()}
        />
      )
    )
  }
  async function click(text: string): Promise<void> {
    const button = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === text || button.getAttribute("aria-label") === text
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
    }
  )
  it("keeps equal-version same-source installation disabled", async () => {
    api.marketplaceCatalog.mockResolvedValue({
      entries: [{ ...entry, installedVersion: "2.0.0", updateAvailable: false }],
      sources,
    })
    await render()
    const button = [...host.querySelectorAll("button")].find(
      (button) => button.textContent === "已安装"
    )!
    expect(button).toBeTruthy()
    expect(button.disabled).toBe(true)
    expect(api.marketplacePreview).not.toHaveBeenCalled()
  })
  it("browses actual metadata, searches category, and explicitly refreshes cache", async () => {
    await render()
    expect(host.textContent).toContain("整理研究资料")
    await render("missing")
    expect(host.textContent).not.toContain("整理研究资料")
    await render("research", 1)
    expect(host.textContent).toContain("整理研究资料")
    expect(api.marketplaceCatalog).toHaveBeenLastCalledWith({ cwd: "D:/project", refresh: true })
  })
  it("shows author icons in a compact list and opens a full detail page without starting installation", async () => {
    const onDetailChange = vi.fn()
    await act(async () =>
      root.render(
        <Marketplace
          query="research"
          refreshRequest={0}
          projectPath="D:/project"
          notify={vi.fn()}
          onDetailChange={onDetailChange}
        />
      )
    )
    expect(host.querySelector(`img[src="${entry.plugin.icon}"]`)).toBeTruthy()
    expect(host.textContent).not.toContain("已安装 1.0.0")
    expect(host.textContent).not.toContain("research")
    await click("查看 测试插件 详情")
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(host.querySelector("h1")?.textContent).toBe("测试插件")
    expect(document.activeElement).toBe(host.querySelector("h1"))
    expect(host.textContent).toContain("在这里查看完整介绍")
    expect(host.textContent).toContain("1.0.0")
    expect(host.textContent).toContain(">=24.0.0")
    expect(host.textContent).toContain("团队源")
    expect(onDetailChange).toHaveBeenLastCalledWith(true)
    const example = host.querySelector<HTMLButtonElement>('[aria-label="使用示例：整理资料"]')!
    expect(example.disabled).toBe(true)
    await click("使用示例：整理资料")
    expect(api.marketplacePreview).not.toHaveBeenCalled()
    await click("返回插件市场")
    expect(onDetailChange).toHaveBeenLastCalledWith(false)
    expect(document.activeElement).toBe(host.querySelector("h2"))
    expect(host.textContent).toContain("整理研究资料")
  })
  it("keeps an unavailable author icon usable via its fallback", async () => {
    await render()
    const image = host.querySelector("img")!
    expect(image).toBeTruthy()
    await act(async () => image.dispatchEvent(new Event("error")))
    expect(host.querySelector("img")).toBeNull()
    await click("查看 测试插件 详情")
    expect(host.querySelector("h1")?.textContent).toBe("测试插件")
  })
  it("shows a short description once and leaves absent author content empty", async () => {
    api.marketplaceCatalog.mockResolvedValue({
      entries: [{ ...entry, plugin: { ...entry.plugin, introduction: undefined } }],
      sources,
    })
    await render()
    await click("查看 测试插件 详情")
    expect(host.textContent?.split(entry.plugin.description)).toHaveLength(2)
    expect(host.textContent).not.toContain("作者暂未提供")
    expect(host.textContent).not.toContain("与当前版本兼容")
    expect(api.marketplacePreview).not.toHaveBeenCalled()
  })
  it("waits for the confirmed receipt, refreshes detail state, and keeps another source's identical ID separate", async () => {
    const notify = vi.fn()
    const onUse = vi.fn(async () => {})
    let finish!: (value: unknown) => void
    api.marketplaceConfirm.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve
      })
    )
    api.snapshot.mockResolvedValue({
      plugins: [
        {
          identity: { id: entry.plugin.id, version: "2.0.0" },
          enabled: true,
          installation: "installed",
          permissions: { requested: [], approved: [], missing: [] },
          runtimeStatus: { state: "pending_reload" },
        },
      ],
    })
    await act(async () =>
      root.render(
        <Marketplace
          query=""
          refreshRequest={0}
          projectPath="D:/project"
          notify={notify}
          onUse={onUse}
        />
      )
    )
    await click("查看 测试插件 详情")
    await click("更新")
    await click("确认安装")
    expect(notify).not.toHaveBeenCalled()
    expect(host.textContent).not.toContain("新建对话使用")
    const updated = { ...entry, installedVersion: "2.0.0", updateAvailable: false }
    api.marketplaceCatalog.mockResolvedValue({
      entries: [updated, { ...updated, sourceId: "other" }],
      sources,
    })
    await act(async () =>
      finish({
        operationId: "saved-once",
        pluginId: entry.plugin.id,
        status: "installed",
        message: "已安装",
      })
    )
    expect(notify).toHaveBeenCalledTimes(1)
    expect(host.textContent).toContain("saved-once")
    expect(host.textContent).not.toContain("1.0.0")
    await click("使用示例：整理资料")
    expect(onUse).toHaveBeenLastCalledWith(
      (await api.snapshot.mock.results[0]!.value).plugins[0],
      entry.plugin.prompts[0]!.prompt
    )
    await click("新建对话使用")
    expect(onUse).toHaveBeenCalledTimes(2)
    await click("返回插件市场")
    const rows = host.querySelectorAll("[data-extension-row]")
    await act(async () => rows[1]!.querySelector("button")!.click())
    expect(host.textContent).not.toContain("saved-once")
    expect(host.textContent).not.toContain("新建对话使用")
    expect(host.textContent).toContain("更换来源")
    expect(
      host.querySelector<HTMLButtonElement>('[aria-label="使用示例：整理资料"]')!.disabled
    ).toBe(true)
  })
  it("keeps examples blocked when an installed receipt still has missing runtime permissions", async () => {
    const onUse = vi.fn(async () => {})
    api.marketplaceConfirm.mockResolvedValue({
      operationId: "confirmed-with-missing-permission",
      pluginId: entry.plugin.id,
      status: "installed",
      message: "已安装",
    })
    api.snapshot.mockResolvedValue({
      plugins: [
        {
          identity: { id: entry.plugin.id, version: "2.0.0" },
          enabled: true,
          installation: "installed",
          permissions: { requested: ["ui:render"], approved: [], missing: ["ui:render"] },
          runtimeStatus: { state: "pending_reload" },
        },
      ],
    })
    await act(async () =>
      root.render(
        <Marketplace
          query=""
          refreshRequest={0}
          projectPath="D:/project"
          notify={vi.fn()}
          onUse={onUse}
        />
      )
    )
    await click("查看 测试插件 详情")
    await click("更新")
    api.marketplaceCatalog.mockResolvedValue({
      entries: [{ ...entry, installedVersion: "2.0.0", updateAvailable: false }],
      sources,
    })
    await click("确认安装")
    expect(host.textContent).toContain("confirmed-with-missing-permission")
    expect(host.textContent).not.toContain("新建对话使用")
    expect(
      host.querySelector<HTMLButtonElement>('[aria-label="使用示例：整理资料"]')!.disabled
    ).toBe(true)
    await click("使用示例：整理资料")
    expect(onUse).not.toHaveBeenCalled()
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
        (button) => button.textContent === "移除 内置源"
      )
    ).toBe(false)
    const sourceInput = document.querySelector<HTMLInputElement>('input[aria-label="插件源地址"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        sourceInput,
        "https://new.example.com/index.json"
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

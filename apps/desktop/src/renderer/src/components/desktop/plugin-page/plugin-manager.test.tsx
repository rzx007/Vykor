// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { DesktopPluginInfo, DesktopPluginSnapshot } from "@shared/plugin-types"
import { PluginManager, type PluginManagerProps } from "./plugin-manager"

const snapshot = { cwd: "D:/project", plugins: [], warnings: [] }
const plugin = (overrides: Partial<DesktopPluginInfo> = {}): DesktopPluginInfo => ({
  identity: { id: "alpha", name: "alpha", version: "1.0.0", displayName: "Alpha" },
  origin: "native",
  scope: "user",
  enabled: true,
  installation: "installed",
  activation: "active",
  runtimeStatus: {
    state: "pending_reload",
    message: "已启用，下一次对话生效。",
    action: "reload",
  },
  inventory: {},
  permissions: { requested: [], approved: [], missing: [] },
  diagnostics: [],
  ...overrides,
})
const populatedSnapshot: DesktopPluginSnapshot = {
  cwd: "D:/project",
  warnings: [],
  plugins: [
    plugin(),
    plugin({
      identity: { id: "beta", name: "beta", version: "2.0.0", displayName: "Beta" },
      enabled: false,
      activation: "partial",
      runtimeStatus: {
        state: "failed",
        code: "snapshot_missing",
        message: "加载失败：插件文件不完整，请重新导入 ZIP。",
        action: "reimport",
      },
    }),
    plugin({
      identity: { id: "managed", name: "managed", version: "1.0.0", displayName: "Managed" },
      scope: "managed",
    }),
  ],
}

describe("PluginManager archive import", () => {
  let root: Root
  let host: HTMLDivElement
  let props: PluginManagerProps

  beforeEach(() => {
    ;(
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true
    vi.clearAllMocks()
    Object.defineProperty(window, "desktop", {
      configurable: true,
      value: {
        plugins: {
          snapshot: vi.fn(async () => snapshot),
          reload: vi.fn(async () => snapshot),
          importArchive: vi.fn(),
          confirmArchive: vi.fn(),
          cancelArchive: vi.fn(),
          enable: vi.fn(),
          disable: vi.fn(),
          uninstall: vi.fn(),
        },
      },
    })
    host = document.createElement("div")
    document.body.append(host)
    root = createRoot(host)
    props = {
      query: "",
      addRequest: 0,
      refreshRequest: 0,
      projectPath: "D:/project",
      notify: vi.fn(),
    }
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT
  })

  const api = (): {
    snapshot: ReturnType<typeof vi.fn>
    reload: ReturnType<typeof vi.fn>
    importArchive: ReturnType<typeof vi.fn>
    confirmArchive: ReturnType<typeof vi.fn>
    cancelArchive: ReturnType<typeof vi.fn>
    enable: ReturnType<typeof vi.fn>
    disable: ReturnType<typeof vi.fn>
    uninstall: ReturnType<typeof vi.fn>
  } => window.desktop!.plugins as never

  async function render(next: Partial<PluginManagerProps> = {}): Promise<void> {
    props = { ...props, ...next }
    await act(async () => {
      root.render(<PluginManager {...props} />)
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  async function click(label: string): Promise<void> {
    const target = [
      ...document.querySelectorAll<HTMLElement>("button, [aria-label], [role='menuitem']"),
    ].find(
      (item) => item.textContent?.trim() === label || item.getAttribute("aria-label") === label
    )
    expect(target, `interactive control: ${label}`).toBeTruthy()
    await act(async () => {
      target!.click()
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  async function requestImport(): Promise<void> {
    await render({ addRequest: props.addRequest + 1 })
  }

  it("keeps archive import on the page add request instead of an in-page button", async () => {
    await render()

    expect(host.textContent).not.toContain("导入插件")
    expect(host.textContent).not.toContain("添加插件配置")
    expect(
      [...host.querySelectorAll("button")].filter((item) => item.textContent?.trim() === "导入插件")
    ).toHaveLength(0)
  })

  it("runs a top-menu import request after the initial snapshot has finished", async () => {
    let resolveSnapshot!: (value: typeof snapshot) => void
    api().snapshot.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSnapshot = resolve
        })
    )
    api().importArchive.mockResolvedValue({ status: "cancelled" })
    await render()
    await render({ addRequest: 1 })

    expect(api().importArchive).not.toHaveBeenCalled()
    await act(async () => {
      resolveSnapshot(snapshot)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(api().importArchive).toHaveBeenCalledWith({ cwd: "D:/project" })
  })

  it("starts only one archive import while the picker request is busy", async () => {
    let resolveImport!: (value: { status: "cancelled" }) => void
    api().importArchive.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveImport = resolve
        })
    )
    await render()
    await requestImport()
    await requestImport()

    expect(api().importArchive).toHaveBeenCalledTimes(1)
    expect(api().importArchive).toHaveBeenCalledWith({ cwd: "D:/project" })
    await act(async () => resolveImport({ status: "cancelled" }))
  })

  it("keeps cancellation silent", async () => {
    api().importArchive.mockResolvedValue({ status: "cancelled" })
    await render()
    await requestImport()

    expect(props.notify).not.toHaveBeenCalled()
    expect(document.querySelector('[role="alert"]')).toBeNull()
  })

  it("shows one accessible permission confirmation and confirms without resending permissions", async () => {
    api().importArchive.mockResolvedValue({
      status: "approval-required",
      selectionId: "selection-1",
      pluginName: "Archive Plugin",
      requestedPermissions: [
        "filesystem:read:workspace",
        "network:api.example.com",
        "network:api.example.com",
      ],
    })
    api().confirmArchive.mockResolvedValue({ status: "installed", pluginName: "Archive Plugin" })
    await render()
    await requestImport()

    const dialog = document.querySelector('[role="alertdialog"]')
    expect(dialog?.textContent).toContain("安装「Archive Plugin」？")
    expect(dialog?.textContent).toContain("该插件需要以下权限才能正常工作。")
    expect(dialog?.textContent).toContain("文件访问")
    expect(dialog?.textContent).toContain("read:workspace")
    expect(dialog?.textContent).toContain("网络访问")
    const labelledBy = dialog?.getAttribute("aria-labelledby")
    const describedBy = dialog?.getAttribute("aria-describedby")
    expect(labelledBy).toBeTruthy()
    expect(describedBy).toBeTruthy()
    expect(document.getElementById(labelledBy!)?.textContent).toContain("安装「Archive Plugin」？")
    expect(document.getElementById(describedBy!)?.textContent).toContain(
      "该插件需要以下权限才能正常工作。"
    )

    await click("安装")

    expect(api().confirmArchive).toHaveBeenCalledWith({
      cwd: "D:/project",
      selectionId: "selection-1",
    })
    expect(api().cancelArchive).not.toHaveBeenCalled()
    expect(props.notify).toHaveBeenCalledWith(expect.stringContaining("插件列表可刷新"))
  })

  it("cancels one pending permission selection exactly once", async () => {
    api().importArchive.mockResolvedValue({
      status: "approval-required",
      selectionId: "selection-2",
      pluginName: "Archive Plugin",
      requestedPermissions: ["process:node"],
    })
    await render()
    await requestImport()

    await click("取消")

    expect(api().cancelArchive).toHaveBeenCalledTimes(1)
    expect(api().cancelArchive).toHaveBeenCalledWith({ selectionId: "selection-2" })
  })

  it("keeps failed diagnostics closed until requested and allows another import", async () => {
    api()
      .importArchive.mockResolvedValueOnce({
        status: "failed",
        message: "压缩包无法安装",
        details: [{ code: "plugin_archive_invalid", path: "plugin/manifest.json" }],
      })
      .mockResolvedValueOnce({ status: "installed", pluginName: "Retry Plugin", snapshot })
    await render()
    await requestImport()

    const alert = document.querySelector('[role="alert"]')
    expect(alert?.textContent).toContain("压缩包无法安装")
    expect(alert?.textContent).not.toContain("plugin_archive_invalid")
    await click("查看详情")
    expect(alert?.textContent).toContain("plugin_archive_invalid")

    await requestImport()
    expect(api().importArchive).toHaveBeenCalledTimes(2)
    expect(props.notify).toHaveBeenCalledWith("Retry Plugin 已安装或更新，将在下次对话中生效。")
  })

  it("treats an unknown result as a refreshable warning rather than installation", async () => {
    api().importArchive.mockResolvedValue({
      status: "unknown",
      pluginName: "Uncertain Plugin",
      message: "安装结果暂时无法确认，请刷新插件列表。",
      details: [{ code: "plugin_archive_install_unknown" }],
    })
    await render()
    await requestImport()

    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "安装结果暂时无法确认，请刷新插件列表。"
    )
    expect(props.notify).not.toHaveBeenCalled()
  })

  it("does not access legacy plugin localStorage while rendering or importing", async () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem")
    const setItem = vi.spyOn(Storage.prototype, "setItem")
    const removeItem = vi.spyOn(Storage.prototype, "removeItem")
    api().importArchive.mockResolvedValue({ status: "cancelled" })
    await render()
    await requestImport()

    expect(getItem).not.toHaveBeenCalled()
    expect(setItem).not.toHaveBeenCalled()
    expect(removeItem).not.toHaveBeenCalled()
  })

  it("filters a populated plugin list by query and attention state", async () => {
    api().snapshot.mockResolvedValue(populatedSnapshot)
    await render({ query: "beta" })

    expect(host.querySelectorAll("[data-extension-row]")).toHaveLength(1)
    expect(host.textContent).toContain("Beta")
    expect(host.textContent).not.toContain("Alpha ·")

    await render({ query: "" })
    await click("需处理")

    expect(host.querySelectorAll("[data-extension-row]")).toHaveLength(1)
    expect(host.textContent).toContain("Beta")
    expect(host.textContent).not.toContain("Managed ·")
  })

  it("shows runtime status in the plugin list and details", async () => {
    api().snapshot.mockResolvedValue(populatedSnapshot)
    await render()

    expect(host.textContent).toContain("已启用，下一次对话生效。")
    expect(host.textContent).toContain("加载失败：插件文件不完整，请重新导入 ZIP。")

    await click("查看 Beta 详情")

    const dialog = document.querySelector('[role="dialog"]')
    expect(dialog?.textContent).toContain("运行状态")
    expect(dialog?.textContent).toContain("加载失败：插件文件不完整，请重新导入 ZIP。")
    expect(dialog?.textContent).toContain("请重新导入 ZIP。")
  })

  it("disables a user plugin with its project context and updates the list snapshot", async () => {
    api().snapshot.mockResolvedValue(populatedSnapshot)
    api().disable.mockResolvedValue({
      ...populatedSnapshot,
      plugins: populatedSnapshot.plugins.filter((item) => item.identity.id !== "alpha"),
    })
    await render()

    await click("禁用 Alpha")

    expect(api().disable).toHaveBeenCalledWith({ cwd: "D:/project", pluginId: "alpha" })
    expect(host.textContent).not.toContain("Alpha ·")
    expect(host.textContent).toContain("Beta")
  })

  it("uninstalls a user plugin through its confirmation dialog and updates the list snapshot", async () => {
    api().snapshot.mockResolvedValue(populatedSnapshot)
    api().uninstall.mockResolvedValue({
      ...populatedSnapshot,
      plugins: populatedSnapshot.plugins.filter((item) => item.identity.id !== "alpha"),
    })
    await render()

    await click("Alpha 更多操作")
    await click("卸载")
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain(
      "卸载插件 Alpha？"
    )
    await click("确认卸载")

    expect(api().uninstall).toHaveBeenCalledWith({ cwd: "D:/project", pluginId: "alpha" })
    expect(host.textContent).not.toContain("Alpha ·")
  })

  it("keeps managed plugin controls disabled and never starts a mutation", async () => {
    api().snapshot.mockResolvedValue(populatedSnapshot)
    await render()

    const managedSwitch = document.querySelector<HTMLElement>('[aria-label="禁用 Managed"]')
    expect(managedSwitch?.hasAttribute("data-disabled")).toBe(true)
    await click("Managed 更多操作")
    const uninstall = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (item) => item.textContent?.trim() === "卸载"
    )
    expect(uninstall?.getAttribute("data-disabled")).not.toBeNull()
    await act(async () => uninstall?.click())

    expect(api().enable).not.toHaveBeenCalled()
    expect(api().disable).not.toHaveBeenCalled()
    expect(api().uninstall).not.toHaveBeenCalled()
  })

  it("opens plugin details from a populated list", async () => {
    api().snapshot.mockResolvedValue(populatedSnapshot)
    await render()

    await click("查看 Alpha 详情")

    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("alpha@1.0.0")
  })

  it("hides my-plugins and keeps a single empty prompt when nothing is installed", async () => {
    await render()

    expect(host.textContent).toContain("已安装")
    expect(host.textContent).toContain("还没有插件")
    expect(host.textContent).not.toContain("导入本地插件包")
    expect(host.textContent).not.toContain("我的插件")
    expect(host.textContent).not.toContain("还没有安装插件")
    expect(
      [...host.querySelectorAll("button")].filter((item) => item.textContent?.trim() === "导入插件")
    ).toHaveLength(0)
  })

  it("does not flash my-plugins while the snapshot is still loading", async () => {
    api().snapshot.mockImplementationOnce(() => new Promise(() => undefined))
    await render()

    expect(host.querySelector('[aria-label="正在加载插件"]')).not.toBeNull()
    expect(host.textContent).not.toContain("我的插件")
    expect(host.textContent).not.toContain("还没有插件")
  })

  it("keeps my-plugins when installed plugins are filtered to an empty list", async () => {
    api().snapshot.mockResolvedValue(populatedSnapshot)
    await render({ query: "does-not-exist" })

    expect(host.textContent).toContain("我的插件")
    expect(host.textContent).toContain("没有找到匹配的插件")
    expect(host.textContent).not.toContain("还没有插件")
  })
})

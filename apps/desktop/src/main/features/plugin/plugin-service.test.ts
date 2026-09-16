import { resolve } from "node:path"

import type { PluginInfo } from "@openharness/client"
import { beforeEach, describe, expect, it, vi } from "vitest"

const daemon = vi.hoisted(() => {
  const plugins = {
    list: vi.fn(),
    enable: vi.fn(),
    disable: vi.fn(),
    uninstall: vi.fn(),
    reload: vi.fn(),
    previewArchive: vi.fn(),
    installArchive: vi.fn(),
    previewGit: vi.fn(),
    installGit: vi.fn(),
  }
  return { plugins }
})

const electron = vi.hoisted(() => ({
  BrowserWindow: { fromWebContents: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
}))

vi.mock("../session/session-service", () => ({
  desktopSessionService: {
    daemonClient: vi.fn(async () => daemon),
    refreshDaemonClient: vi.fn(async () => daemon),
  },
}))

vi.mock("electron", () => electron)

import { DesktopPluginService, pickPluginArchive } from "./plugin-service"

const examplePlugin: PluginInfo = {
  identity: { id: "context7", name: "context7", displayName: "Context7", version: "1.0.0" },
  origin: "converted",
  sourceFormat: "claude-code",
  scope: "user",
  enabled: true,
  installation: "installed",
  activation: "active",
  runtimeStatus: {
    state: "loaded",
    message: "插件已加载。",
    action: "none",
  },
  inventory: { tools: 2 },
  permissions: { requested: ["network"], approved: ["network"], missing: [] },
  diagnostics: [],
}

describe("DesktopPluginService", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    daemon.plugins.list.mockResolvedValue({ plugins: [examplePlugin], warnings: [] })
    daemon.plugins.enable.mockResolvedValue({ message: "enabled" })
    daemon.plugins.disable.mockResolvedValue({ message: "disabled" })
    daemon.plugins.uninstall.mockResolvedValue({ message: "uninstalled" })
    daemon.plugins.reload.mockResolvedValue({
      plugins: [examplePlugin],
      warnings: ["cache rebuilt"],
      message: "reloaded",
    })
    daemon.plugins.previewArchive.mockResolvedValue({
      archiveDigest: "a".repeat(64),
      identity: { id: "archive-plugin", name: "archive-plugin", version: "1.0.0" },
      requestedPermissions: [],
      approvalRequired: false,
      inventory: {},
      diagnostics: [],
    })
    daemon.plugins.installArchive.mockResolvedValue({ message: "installed" })
    electron.BrowserWindow.fromWebContents.mockReset()
    electron.dialog.showOpenDialog.mockReset()
  })

  it("normalizes cwd and returns the installed plugin snapshot", async () => {
    const service = new DesktopPluginService()
    const snapshot = await service.snapshot({ cwd: "C:/workspace/project" })

    expect(snapshot).toEqual({
      cwd: resolve("C:/workspace/project"),
      plugins: [examplePlugin],
      warnings: [],
    })
    expect(daemon.plugins.list).toHaveBeenCalledWith({ cwd: resolve("C:/workspace/project") })
  })

  it("mutates a plugin and refreshes the snapshot", async () => {
    const service = new DesktopPluginService()
    const snapshot = await service.disable({ cwd: "C:/workspace/project", pluginId: " context7 " })

    expect(daemon.plugins.disable).toHaveBeenCalledWith("context7", {
      cwd: resolve("C:/workspace/project"),
    })
    expect(daemon.plugins.list).toHaveBeenCalledOnce()
    expect(snapshot.plugins).toEqual([examplePlugin])
  })

  it("uses the reload response without issuing a second list request", async () => {
    const service = new DesktopPluginService()
    const snapshot = await service.reload({ cwd: "C:/workspace/project" })

    expect(snapshot.warnings).toEqual(["cache rebuilt"])
    expect(daemon.plugins.reload).toHaveBeenCalledWith({ cwd: resolve("C:/workspace/project") })
    expect(daemon.plugins.list).not.toHaveBeenCalled()
  })

  it("returns cancelled without previewing when the native ZIP picker is cancelled", async () => {
    const chooseArchive = vi.fn(async () => null)
    const service = new DesktopPluginService({ chooseArchive })

    await expect((service as any).importArchive({} as never, { cwd: "C:/workspace" })).resolves.toEqual({
      status: "cancelled",
    })
    expect(daemon.plugins.previewArchive).not.toHaveBeenCalled()
  })

  it("installs a permission-free archive immediately and never exposes its path or digest", async () => {
    const service = new DesktopPluginService({
      chooseArchive: async () => "C:/private/Plugin.ZIP",
    })

    const result = await (service as any).importArchive({} as never, { cwd: "C:/workspace" })

    expect(daemon.plugins.previewArchive).toHaveBeenCalledWith({
      cwd: resolve("C:/workspace"),
      archivePath: "C:/private/Plugin.ZIP",
    })
    expect(daemon.plugins.installArchive).toHaveBeenCalledWith({
      cwd: resolve("C:/workspace"),
      archivePath: "C:/private/Plugin.ZIP",
      expectedArchiveDigest: "a".repeat(64),
      approvedPermissions: [],
    })
    expect(result).toEqual({ status: "installed", snapshot: expect.any(Object), pluginName: "archive-plugin" })
    expect(JSON.stringify(result)).not.toContain("C:/private")
    expect(JSON.stringify(result)).not.toContain("a".repeat(64))
  })

  it("reinstalls immediately when existing approval covers requested permissions", async () => {
    daemon.plugins.previewArchive.mockResolvedValue({
      archiveDigest: "d".repeat(64),
      identity: { id: "archive-plugin", name: "Archive Plugin", version: "1.1.0" },
      requestedPermissions: ["process:spawn"],
      approvalRequired: false,
      inventory: {},
      diagnostics: [],
    })
    const service = new DesktopPluginService({
      chooseArchive: async () => "C:/private/plugin.zip",
    })

    await expect(
      (service as any).importArchive({} as never, { cwd: "C:/workspace" })
    ).resolves.toMatchObject({ status: "installed", pluginName: "Archive Plugin" })
    expect(daemon.plugins.installArchive).toHaveBeenCalledWith({
      cwd: resolve("C:/workspace"),
      archivePath: "C:/private/plugin.zip",
      expectedArchiveDigest: "d".repeat(64),
      approvedPermissions: [],
    })
  })

  it("stores an approval once, confirms using stored archive details, and consumes the selection", async () => {
    daemon.plugins.previewArchive.mockResolvedValue({
      archiveDigest: "b".repeat(64),
      identity: { id: "archive-plugin", name: "Archive Plugin", version: "1.0.0" },
      requestedPermissions: ["network", "process:spawn"],
      approvalRequired: true,
      inventory: {},
      diagnostics: [],
    })
    const service = new DesktopPluginService({
      chooseArchive: async () => "C:/private/plugin.zip",
      createSelectionId: () => "selection-1",
    })

    const preview = await (service as any).importArchive({} as never, { cwd: "C:/workspace" })
    expect(preview).toEqual({
      status: "approval-required",
      selectionId: "selection-1",
      pluginName: "Archive Plugin",
      requestedPermissions: ["network", "process:spawn"],
    })
    expect(JSON.stringify(preview)).not.toContain("C:/private")
    expect(JSON.stringify(preview)).not.toContain("b".repeat(64))

    await expect((service as any).confirmArchive({ cwd: "C:/workspace", selectionId: "selection-1" })).resolves.toMatchObject({
      status: "installed",
      pluginName: "Archive Plugin",
    })
    expect(daemon.plugins.installArchive).toHaveBeenCalledWith({
      cwd: resolve("C:/workspace"),
      archivePath: "C:/private/plugin.zip",
      expectedArchiveDigest: "b".repeat(64),
      approvedPermissions: ["network", "process:spawn"],
    })
    await expect((service as any).confirmArchive({ cwd: "C:/workspace", selectionId: "selection-1" })).resolves.toEqual({
      status: "failed",
      message: "请重新选择插件包。",
      details: [{ code: "plugin_archive_selection_invalid" }],
    })
  })

  it("rejects expired or mismatched selections and evicts the oldest when a ninth selection is created", async () => {
    let now = 10_000
    let nextId = 0
    const service = new DesktopPluginService({
      chooseArchive: async () => "C:/private/plugin.zip",
      now: () => now,
      createSelectionId: () => `selection-${++nextId}`,
    })
    daemon.plugins.previewArchive.mockResolvedValue({
      archiveDigest: "c".repeat(64),
      identity: { id: "archive-plugin", name: "Archive Plugin", version: "1.0.0" },
      requestedPermissions: ["network"],
      approvalRequired: true,
      inventory: {},
      diagnostics: [],
    })

    const first = await (service as any).importArchive({} as never, { cwd: "C:/workspace" })
    await expect((service as any).confirmArchive({ cwd: "C:/other", selectionId: first.selectionId })).resolves.toMatchObject({
      status: "failed",
      message: "请重新选择插件包。",
    })
    now += 10 * 60 * 1000 + 1
    await expect((service as any).confirmArchive({ cwd: "C:/workspace", selectionId: first.selectionId })).resolves.toMatchObject({
      status: "failed",
      message: "请重新选择插件包。",
    })

    now = 30_000
    const selections = await Promise.all(
      Array.from({ length: 9 }, () => (service as any).importArchive({} as never, { cwd: "C:/workspace" }))
    )
    await expect((service as any).confirmArchive({ cwd: "C:/workspace", selectionId: selections[0].selectionId })).resolves.toMatchObject({
      status: "failed",
      message: "请重新选择插件包。",
    })
    expect((service as any).cancelArchive({ selectionId: selections[8].selectionId })).toBeUndefined()
    await expect((service as any).confirmArchive({ cwd: "C:/workspace", selectionId: selections[8].selectionId })).resolves.toMatchObject({
      status: "failed",
      message: "请重新选择插件包。",
    })
  })

  it("accepts a tar.gz plugin archive returned by the picker", async () => {
    const service = new DesktopPluginService({ chooseArchive: async () => "C:/private/plugin.tar.gz" })

    await expect((service as any).importArchive({} as never, { cwd: "C:/workspace" })).resolves.toMatchObject({
      status: "installed",
      pluginName: "archive-plugin",
    })
    expect(daemon.plugins.previewArchive).toHaveBeenCalledWith({
      cwd: resolve("C:/workspace"),
      archivePath: "C:/private/plugin.tar.gz",
    })
  })

  it("rejects an unsupported archive path returned by a picker without leaking its path", async () => {
    const service = new DesktopPluginService({ chooseArchive: async () => "C:/private/plugin.rar" })

    await expect((service as any).importArchive({} as never, { cwd: "C:/workspace" })).resolves.toEqual({
      status: "failed",
      message: "请选择 ZIP、TAR 或 TAR.GZ 格式的插件包。",
      details: [{ code: "plugin_archive_invalid_extension" }],
    })
    expect(daemon.plugins.previewArchive).not.toHaveBeenCalled()
  })

  it("binds the default ZIP picker to the invoking window", async () => {
    const owner = {} as never
    const sender = {} as never
    electron.BrowserWindow.fromWebContents.mockReturnValue(owner)
    electron.dialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ["C:/private/plugin.zip"] })

    await expect(pickPluginArchive(sender)).resolves.toBe("C:/private/plugin.zip")
    expect(electron.dialog.showOpenDialog).toHaveBeenCalledWith(owner, {
      title: "导入插件",
      properties: ["openFile"],
      filters: [{ name: "插件包", extensions: ["zip", "tar", "tgz", "tar.gz"] }],
    })
  })

  it("returns only safe structured diagnostic details without leaking Server messages or absolute paths", async () => {
    daemon.plugins.previewArchive.mockRejectedValue({
      body: {
        code: "plugin_archive_invalid",
        message: "raw preview error for C:/private/plugin.zip",
        diagnostics: [
          { code: "manifest_invalid", path: "plugins/demo/manifest.json", message: "raw relative error" },
          { code: "archive_missing", path: "C:/private/plugin.zip", message: "raw absolute error" },
          { code: "temp_file", path: "C:/Users/name/AppData/Local/Temp/plugin.zip", message: "raw temp error" },
          { code: "drive_relative", path: "C:Users/alice/plugin.json", message: "raw drive relative" },
          { code: "path_escape", path: "foo/../../Users/alice/plugin.json", message: "raw escape" },
          { code: "backslash", path: "skills\\x\\SKILL.md", message: "raw backslash" },
          { code: "null_byte", path: "skills/\u0000/SKILL.md", message: "raw null" },
          { code: "empty_segment", path: "skills//SKILL.md", message: "raw empty" },
          { code: "safe_skill", path: "./skills/x/SKILL.md", message: "raw safe" },
        ],
      },
    })
    const service = new DesktopPluginService({ chooseArchive: async () => "C:/private/plugin.zip" })

    const result = await (service as any).importArchive({} as never, { cwd: "C:/workspace" })
    expect(result).toEqual({
      status: "failed",
      message: "导入插件包失败，请检查插件包后重试。",
      details: [
        { code: "plugin_archive_invalid" },
        { code: "manifest_invalid", path: "plugins/demo/manifest.json" },
        { code: "archive_missing" },
        { code: "temp_file" },
        { code: "drive_relative" },
        { code: "path_escape" },
        { code: "backslash" },
        { code: "null_byte" },
        { code: "empty_segment" },
        { code: "safe_skill", path: "skills/x/SKILL.md" },
      ],
    })
    expect(JSON.stringify(result)).not.toContain("C:/private")
    expect(JSON.stringify(result)).not.toContain("C:/Users/name/AppData/Local/Temp")
    expect(JSON.stringify(result)).not.toContain("raw preview error")
    expect(JSON.stringify(result)).not.toContain("raw relative error")
  })

  it("returns unknown after a direct-install connection failure without retrying the mutation", async () => {
    daemon.plugins.installArchive
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockRejectedValueOnce({ body: { code: "plugin_archive_permissions_not_approved" } })
    const refreshDaemonClient = vi.fn(async () => daemon as never)
    const service = new DesktopPluginService({
      chooseArchive: async () => "C:/private/plugin.zip",
      refreshDaemonClient,
    })

    const result = await (service as any).importArchive({} as never, { cwd: "C:/workspace" })
    expect(result).toEqual({
      status: "unknown",
      pluginName: "archive-plugin",
      message: "安装结果暂时无法确认，请刷新插件列表。",
      details: [{ code: "plugin_archive_install_unknown" }],
    })
    expect(daemon.plugins.installArchive).toHaveBeenCalledOnce()
    expect(refreshDaemonClient).not.toHaveBeenCalled()
    expect(JSON.stringify(result)).not.toContain("C:/private")
    expect(JSON.stringify(result)).not.toContain("a".repeat(64))
  })

  it("returns unknown and consumes the selection after a confirmation-install connection failure without retrying the mutation", async () => {
    daemon.plugins.previewArchive.mockResolvedValue({
      archiveDigest: "e".repeat(64),
      identity: { id: "archive-plugin", name: "Archive Plugin", version: "1.0.0" },
      requestedPermissions: ["network"],
      approvalRequired: true,
      inventory: {},
      diagnostics: [],
    })
    const refreshDaemonClient = vi.fn(async () => daemon as never)
    const service = new DesktopPluginService({
      chooseArchive: async () => "C:/private/plugin.zip",
      createSelectionId: () => "selection-unknown",
      refreshDaemonClient,
    })
    const preview = await (service as any).importArchive({} as never, { cwd: "C:/workspace" })
    daemon.plugins.installArchive
      .mockRejectedValueOnce(new Error("Failed to fetch"))
      .mockRejectedValueOnce({ body: { code: "plugin_archive_permissions_not_approved" } })

    await expect((service as any).confirmArchive({ cwd: "C:/workspace", selectionId: preview.selectionId })).resolves.toEqual({
      status: "unknown",
      pluginName: "Archive Plugin",
      message: "安装结果暂时无法确认，请刷新插件列表。",
      details: [{ code: "plugin_archive_install_unknown" }],
    })
    expect(daemon.plugins.installArchive).toHaveBeenCalledOnce()
    expect(refreshDaemonClient).not.toHaveBeenCalled()
    await expect((service as any).confirmArchive({ cwd: "C:/workspace", selectionId: preview.selectionId })).resolves.toMatchObject({
      status: "failed",
      message: "请重新选择插件包。",
    })
  })

  it("keeps a structured install rejection as failed instead of unknown", async () => {
    daemon.plugins.installArchive.mockRejectedValue({
      body: { code: "plugin_archive_permissions_not_approved", message: "raw rejection" },
    })
    const service = new DesktopPluginService({ chooseArchive: async () => "C:/private/plugin.zip" })

    await expect((service as any).importArchive({} as never, { cwd: "C:/workspace" })).resolves.toEqual({
      status: "failed",
      message: "导入插件包失败，请检查插件包后重试。",
      details: [{ code: "plugin_archive_permissions_not_approved" }],
    })
  })

  it("returns installed with refreshPending when an immediate archive install succeeds but its snapshot cannot refresh", async () => {
    daemon.plugins.list.mockRejectedValue(new Error("Failed to fetch"))
    const service = new DesktopPluginService({ chooseArchive: async () => "C:/private/plugin.zip" })

    await expect((service as any).importArchive({} as never, { cwd: "C:/workspace" })).resolves.toEqual({
      status: "installed",
      pluginName: "archive-plugin",
      refreshPending: true,
    })
    expect(daemon.plugins.installArchive).toHaveBeenCalledOnce()
  })

  it("returns installed with refreshPending when a confirmed archive install succeeds but its snapshot cannot refresh", async () => {
    daemon.plugins.previewArchive.mockResolvedValue({
      archiveDigest: "d".repeat(64),
      identity: { id: "archive-plugin", name: "Archive Plugin", version: "1.0.0" },
      requestedPermissions: ["network"],
      approvalRequired: true,
      inventory: {},
      diagnostics: [],
    })
    const service = new DesktopPluginService({
      chooseArchive: async () => "C:/private/plugin.zip",
      createSelectionId: () => "selection-refresh-pending",
    })
    const preview = await (service as any).importArchive({} as never, { cwd: "C:/workspace" })
    daemon.plugins.list.mockRejectedValue(new Error("Failed to fetch"))

    await expect((service as any).confirmArchive({ cwd: "C:/workspace", selectionId: preview.selectionId })).resolves.toEqual({
      status: "installed",
      pluginName: "Archive Plugin",
      refreshPending: true,
    })
    expect(daemon.plugins.installArchive).toHaveBeenCalledOnce()
  })
})

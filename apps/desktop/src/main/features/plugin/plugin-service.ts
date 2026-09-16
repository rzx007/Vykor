import { randomUUID } from "node:crypto"
import { extname, resolve } from "node:path"

import type { OpenHarnessClient, PluginResource } from "@openharness/client"
import { BrowserWindow, dialog, type OpenDialogOptions, type WebContents } from "electron"

import type {
  DesktopPluginActionInput,
  DesktopPluginArchiveConfirmInput,
  DesktopPluginArchiveConfirmResult,
  DesktopPluginArchiveFailedResult,
  DesktopPluginArchiveInstalledResult,
  DesktopPluginArchiveImportInput,
  DesktopPluginArchiveImportResult,
  DesktopPluginArchiveUnknownResult,
  DesktopPluginContextInput,
  DesktopPluginGitConfirmResult,
  DesktopPluginGitImportInput,
  DesktopPluginGitImportResult,
  DesktopPluginSnapshot,
} from "../../../shared/plugin-types"
import { desktopSessionService } from "../session/session-service"
import { PluginArchiveSelectionStore, PluginGitSelectionStore } from "./selection-store"

const SELECTION_TTL_MS = 10 * 60 * 1_000

export interface DesktopPluginServiceOptions {
  chooseArchive?: (sender: WebContents) => Promise<string | null>
  now?: () => number
  createSelectionId?: () => string
  daemonClient?: () => Promise<OpenHarnessClient>
  refreshDaemonClient?: () => Promise<OpenHarnessClient>
}

export class DesktopPluginService {
  private readonly chooseArchive: (sender: WebContents) => Promise<string | null>
  private readonly now: () => number
  private readonly createSelectionId: () => string
  private readonly daemonClient: () => Promise<OpenHarnessClient>
  private readonly refreshDaemonClient: () => Promise<OpenHarnessClient>
  private readonly selections: PluginArchiveSelectionStore
  private readonly gitSelections: PluginGitSelectionStore

  constructor(options: DesktopPluginServiceOptions = {}) {
    this.chooseArchive = options.chooseArchive ?? pickPluginArchive
    this.now = options.now ?? Date.now
    this.createSelectionId = options.createSelectionId ?? randomUUID
    this.daemonClient = options.daemonClient ?? (() => desktopSessionService.daemonClient())
    this.refreshDaemonClient =
      options.refreshDaemonClient ?? (() => desktopSessionService.refreshDaemonClient())
    this.selections = new PluginArchiveSelectionStore(this.now)
    this.gitSelections = new PluginGitSelectionStore(this.now)
  }

  async snapshot(input: DesktopPluginContextInput): Promise<DesktopPluginSnapshot> {
    const cwd = normalizeCwd(input.cwd)
    const result = await this.withDaemonRetry((client) => client.plugins.list({ cwd }))
    return { cwd, plugins: result.plugins, warnings: result.warnings }
  }

  async enable(input: DesktopPluginActionInput): Promise<DesktopPluginSnapshot> {
    const cwd = normalizeCwd(input.cwd)
    await this.withDaemonRetry((client) => client.plugins.enable(requirePluginId(input.pluginId), { cwd }))
    return await this.snapshot({ cwd })
  }

  async disable(input: DesktopPluginActionInput): Promise<DesktopPluginSnapshot> {
    const cwd = normalizeCwd(input.cwd)
    await this.withDaemonRetry((client) => client.plugins.disable(requirePluginId(input.pluginId), { cwd }))
    return await this.snapshot({ cwd })
  }

  async uninstall(input: DesktopPluginActionInput): Promise<DesktopPluginSnapshot> {
    const cwd = normalizeCwd(input.cwd)
    await this.withDaemonRetry((client) =>
      client.plugins.uninstall(requirePluginId(input.pluginId), { cwd })
    )
    return await this.snapshot({ cwd })
  }

  async reload(input: DesktopPluginContextInput): Promise<DesktopPluginSnapshot> {
    const cwd = normalizeCwd(input.cwd)
    const result = await this.withDaemonRetry((client) => client.plugins.reload({ cwd }))
    return { cwd, plugins: result.plugins, warnings: result.warnings }
  }

  async importArchive(
    sender: WebContents,
    input: DesktopPluginArchiveImportInput
  ): Promise<DesktopPluginArchiveImportResult> {
    const cwd = normalizeCwd(input.cwd)
    let archivePath: string | null
    try {
      archivePath = await this.chooseArchive(sender)
    } catch (error) {
      return archiveFailureFromError(error)
    }
    if (!archivePath) return { status: "cancelled" }
    if (!isSupportedPluginArchive(archivePath)) {
      return archiveFailure("请选择 ZIP、TAR 或 TAR.GZ 格式的插件包。", [
        { code: "plugin_archive_invalid_extension" },
      ])
    }

    let preview: Awaited<ReturnType<PluginResource["previewArchive"]>>
    try {
      preview = await this.withDaemonRetry((client) =>
        client.plugins.previewArchive({ cwd, archivePath })
      )
    } catch (error) {
      return archiveFailureFromError(error)
    }

    const pluginName = preview.identity.displayName ?? preview.identity.name
    if (!preview.approvalRequired) {
      try {
        await this.installArchive(cwd, archivePath, preview.archiveDigest, [])
      } catch (error) {
        if (isConnectionFailure(error)) return unknownInstallResult(pluginName)
        return archiveFailureFromError(error)
      }
      return await this.installedResult(cwd, pluginName)
    }

    const createdAt = this.now()
    const selectionId = this.createSelectionId()
    this.selections.add({
      id: selectionId,
      cwd,
      archivePath,
      archiveDigest: preview.archiveDigest,
      pluginName,
      requestedPermissions: [...preview.requestedPermissions],
      createdAt,
      expiresAt: createdAt + SELECTION_TTL_MS,
    })
    return {
      status: "approval-required",
      selectionId,
      pluginName,
      requestedPermissions: [...preview.requestedPermissions],
    }
  }

  async confirmArchive(
    input: DesktopPluginArchiveConfirmInput
  ): Promise<DesktopPluginArchiveConfirmResult> {
    const cwd = normalizeCwd(input.cwd)
    const selection = this.selections.consume(input.selectionId)
    if (!selection || selection.cwd !== cwd) return selectionFailure()

    try {
      await this.installArchive(
        cwd,
        selection.archivePath,
        selection.archiveDigest,
        selection.requestedPermissions
      )
    } catch (error) {
      if (isConnectionFailure(error)) return unknownInstallResult(selection.pluginName)
      return archiveFailureFromError(error)
    }
    return await this.installedResult(cwd, selection.pluginName)
  }

  cancelArchive(input: { selectionId: string }): void {
    this.selections.cancel(input.selectionId)
  }

  async importGit(input: DesktopPluginGitImportInput): Promise<DesktopPluginGitImportResult> {
    const cwd = normalizeCwd(input.cwd)
    const url = input.url.trim()
    const ref = input.ref?.trim() || undefined
    if (!url) {
      return archiveFailure("请输入 Git 地址。", [{ code: "plugin_git_url_required" }])
    }

    let preview: Awaited<ReturnType<PluginResource["previewGit"]>>
    try {
      preview = await this.withDaemonRetry((client) =>
        client.plugins.previewGit({ cwd, url, ...(ref ? { ref } : {}) })
      )
    } catch (error) {
      return gitFailureFromError(error)
    }

    const pluginName = preview.identity.displayName ?? preview.identity.name
    if (!preview.approvalRequired) {
      try {
        await this.installGit(cwd, url, ref, preview.sourceDigest, [])
      } catch (error) {
        if (isConnectionFailure(error)) return unknownInstallResult(pluginName)
        return gitFailureFromError(error)
      }
      return await this.installedResult(cwd, pluginName)
    }

    const createdAt = this.now()
    const selectionId = this.createSelectionId()
    this.gitSelections.add({
      id: selectionId,
      cwd,
      url,
      ref,
      pluginName,
      expectedSourceDigest: preview.sourceDigest,
      declaredPermissions: preview.declaredPermissions,
      createdAt,
      expiresAt: createdAt + SELECTION_TTL_MS,
    })
    return {
      status: "requires_confirmation",
      selectionId,
      pluginName,
      declaredPermissions: preview.declaredPermissions,
      expiresAt: createdAt + SELECTION_TTL_MS,
    }
  }

  async confirmGit(input: {
    cwd: string
    selectionId: string
    approvedPermissions: string[]
  }): Promise<DesktopPluginGitConfirmResult> {
    const cwd = normalizeCwd(input.cwd)
    const selection = this.gitSelections.get(input.selectionId)
    if (!selection || selection.cwd !== cwd) return gitConfirmationExpired()

    try {
      await this.installGit(
        cwd,
        selection.url,
        selection.ref,
        selection.expectedSourceDigest,
        input.approvedPermissions
      )
      this.gitSelections.delete(input.selectionId)
    } catch (error) {
      if (isConnectionFailure(error)) return unknownInstallResult(selection.pluginName)
      return gitFailureFromError(error)
    }
    return await this.installedResult(cwd, selection.pluginName)
  }

  cancelGit(input: { selectionId: string }): void {
    this.gitSelections.cancel(input.selectionId)
  }

  clearArchiveSelections(): void {
    this.selections.clear()
    this.gitSelections.clear()
  }

  private async installedResult(
    cwd: string,
    pluginName: string
  ): Promise<DesktopPluginArchiveInstalledResult> {
    try {
      const snapshot = await this.snapshot({ cwd })
      return { status: "installed", pluginName, snapshot }
    } catch {
      return { status: "installed", pluginName, refreshPending: true }
    }
  }

  private async installArchive(
    cwd: string,
    archivePath: string,
    expectedArchiveDigest: string,
    approvedPermissions: string[]
  ): Promise<void> {
    await (await this.daemonClient()).plugins.installArchive({
      cwd,
      archivePath,
      expectedArchiveDigest,
      approvedPermissions,
    })
  }

  private async installGit(
    cwd: string,
    url: string,
    ref: string | undefined,
    expectedSourceDigest: string,
    approvedPermissions: string[]
  ): Promise<void> {
    await (await this.daemonClient()).plugins.installGit({
      cwd,
      url,
      ...(ref ? { ref } : {}),
      expectedSourceDigest,
      approvedPermissions,
    })
  }

  private async withDaemonRetry<T>(
    operation: (client: OpenHarnessClient) => Promise<T>
  ): Promise<T> {
    try {
      return await operation(await this.daemonClient())
    } catch (error) {
      if (!isConnectionFailure(error)) {
        throw error
      }
      return await operation(await this.refreshDaemonClient())
    }
  }
}

export const desktopPluginService = new DesktopPluginService()

function normalizeCwd(value: string): string {
  return resolve(value.trim() || process.cwd())
}

function requirePluginId(value: string): string {
  const pluginId = value.trim()
  if (!pluginId) throw new Error("缺少插件 ID。")
  return pluginId
}

function isSupportedPluginArchive(archivePath: string): boolean {
  const lower = archivePath.toLowerCase()
  const extension = extname(lower)
  return extension === ".zip" || extension === ".tar" || extension === ".tgz" || lower.endsWith(".tar.gz")
}

function selectionFailure(): DesktopPluginArchiveFailedResult {
  return archiveFailure("请重新选择插件包。", [
    { code: "plugin_archive_selection_invalid" },
  ])
}

function archiveFailureFromError(error: unknown): DesktopPluginArchiveFailedResult {
  const body = error && typeof error === "object" && "body" in error ? error.body : undefined
  const code = stringProperty(body, "code") ?? "plugin_archive_failed"
  const details = [{ code }, ...diagnosticDetails(body)]
  if (code === "plugin_archive_changed") {
    return archiveFailure("请重新选择插件包。", details)
  }
  return archiveFailure("导入插件包失败，请检查插件包后重试。", details)
}

function gitFailureFromError(error: unknown): DesktopPluginArchiveFailedResult {
  const body = error && typeof error === "object" && "body" in error ? error.body : undefined
  const code = stringProperty(body, "code") ?? "plugin_git_failed"
  const details = [{ code }, ...diagnosticDetails(body)]
  if (code === "plugin_git_changed") {
    return archiveFailure("请重新预览 Git 插件。", details)
  }
  return archiveFailure("从 Git 安装插件失败，请检查地址或插件内容后重试。", details)
}

function archiveFailure(
  message: string,
  details: DesktopPluginArchiveFailedResult["details"]
): DesktopPluginArchiveFailedResult {
  return { status: "failed", message, details }
}

function unknownInstallResult(pluginName: string): DesktopPluginArchiveUnknownResult {
  return {
    status: "unknown",
    pluginName,
    message: "安装结果暂时无法确认，请刷新插件列表。",
    details: [{ code: "plugin_archive_install_unknown" }],
  }
}

function diagnosticDetails(value: unknown): DesktopPluginArchiveFailedResult["details"] {
  if (!value || typeof value !== "object" || !("diagnostics" in value)) return []
  const diagnostics = value.diagnostics
  if (!Array.isArray(diagnostics)) return []
  return diagnostics.flatMap((diagnostic) => {
    const code = stringProperty(diagnostic, "code")
    if (!code) return []
    const path = safeRelativePath(stringProperty(diagnostic, "path"))
    return path ? [{ code, path }] : [{ code }]
  })
}

function stringProperty(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object" || !(key in value)) return undefined
  const property = value[key as keyof typeof value]
  return typeof property === "string" ? property : undefined
}

function safeRelativePath(value: string | undefined): string | undefined {
  let path = value?.trim()
  if (!path) return undefined
  if (path.startsWith("./")) path = path.slice(2)
  if (!path) return undefined
  const segments = path.split("/")
  if (
    path.startsWith("/") ||
    path.includes(":") ||
    path.includes("\\") ||
    path.includes("\0") ||
    segments.some((segment) => !segment || segment === "." || segment === "..") ||
    segments.some((segment) => /^(?:private|temp|tmp|archive)$/i.test(segment))
  ) {
    return undefined
  }
  return path
}

function isConnectionFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return (
    message.includes("Failed to fetch") ||
    message.includes("ECONNREFUSED") ||
    message.includes("ECONNRESET")
  )
}

export async function pickPluginArchive(sender: WebContents): Promise<string | null> {
  const owner = BrowserWindow.fromWebContents(sender) ?? undefined
  const options: OpenDialogOptions = {
    title: "导入插件",
    properties: ["openFile"],
    filters: [{ name: "插件包", extensions: ["zip", "tar", "tgz", "tar.gz"] }],
  }
  const result = owner
    ? await dialog.showOpenDialog(owner, options)
    : await dialog.showOpenDialog(options)
  return result.canceled ? null : (result.filePaths[0] ?? null)
}

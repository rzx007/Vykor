import type { PluginInfo } from "@vykor/client"

export type DesktopPluginInfo = PluginInfo

export interface DesktopPluginContextInput {
  cwd: string
}

export interface DesktopPluginActionInput extends DesktopPluginContextInput {
  pluginId: string
}

export type DesktopPluginArchiveImportInput = DesktopPluginContextInput

export interface DesktopPluginGitImportInput extends DesktopPluginContextInput {
  url: string
  ref?: string
}

export interface DesktopPluginArchiveConfirmInput extends DesktopPluginContextInput {
  selectionId: string
}

export interface DesktopPluginArchiveCancelInput {
  selectionId: string
}

export interface DesktopPluginArchiveFailureDetail {
  code: string
  path?: string
}

export interface DesktopPluginArchiveFailedResult {
  status: "failed"
  message: string
  details: DesktopPluginArchiveFailureDetail[]
}

export interface DesktopPluginArchiveInstalledResult {
  status: "installed"
  snapshot?: DesktopPluginSnapshot
  pluginName: string
  refreshPending?: true
}

export interface DesktopPluginArchiveUnknownResult {
  status: "unknown"
  pluginName: string
  message: "安装结果暂时无法确认，请刷新插件列表。"
  details?: DesktopPluginArchiveFailureDetail[]
}

export type DesktopPluginArchiveImportResult =
  | { status: "cancelled" }
  | {
      status: "approval-required"
      selectionId: string
      pluginName: string
      requestedPermissions: string[]
    }
  | DesktopPluginArchiveInstalledResult
  | DesktopPluginArchiveUnknownResult
  | DesktopPluginArchiveFailedResult

export type DesktopPluginArchiveConfirmResult =
  | DesktopPluginArchiveInstalledResult
  | DesktopPluginArchiveUnknownResult
  | DesktopPluginArchiveFailedResult

export type DesktopPluginGitImportResult = DesktopPluginArchiveImportResult

export type DesktopPluginGitConfirmResult = DesktopPluginArchiveConfirmResult

export interface DesktopPluginSnapshot {
  cwd: string
  plugins: DesktopPluginInfo[]
  warnings: string[]
}

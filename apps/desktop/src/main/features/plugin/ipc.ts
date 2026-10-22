import { app } from "electron"

import { IpcChannels, type IpcInvokeMap } from "../../../shared/ipc-channels"
import type {
  DesktopPluginActionInput,
  DesktopPluginArchiveCancelInput,
  DesktopPluginArchiveConfirmInput,
  DesktopPluginGitImportInput,
  DesktopPluginArchiveImportInput,
  DesktopPluginContextInput,
} from "../../../shared/plugin-types"
import type { IpcContribution } from "../../core/ipc/types"
import { desktopPluginService, type DesktopPluginService } from "./plugin-service"

type PluginIpcService = Pick<
  DesktopPluginService,
  | "marketplace"
  | "marketplaceCatalog"
  | "marketplaceSources"
  | "marketplaceAddSource"
  | "marketplaceSetSourceEnabled"
  | "marketplaceRemoveSource"
  | "snapshot"
  | "loadIcon"
  | "enable"
  | "disable"
  | "uninstall"
  | "reload"
  | "importArchive"
  | "confirmArchive"
  | "cancelArchive"
  | "importGit"
  | "confirmGit"
  | "cancelGit"
  | "clearArchiveSelections"
>

export function createPluginIpcContribution(service: PluginIpcService): IpcContribution {
  let quitCleanupRegistered = false

  return {
    id: "plugin",
    register() {
      if (!quitCleanupRegistered) {
        quitCleanupRegistered = true
        app.once("before-quit", () => service.clearArchiveSelections())
      }
      return [
        {
          channel: IpcChannels.marketplaceCatalog,
          handler: (event, input) => {
            const value = input as IpcInvokeMap[typeof IpcChannels.marketplaceCatalog]["args"][0]
            return service.marketplaceCatalog({ cwd: value.cwd, refresh: value.refresh })
          },
        },
        { channel: IpcChannels.marketplaceSources, handler: () => service.marketplaceSources() },
        {
          channel: IpcChannels.marketplaceAddSource,
          handler: (event, input) => {
            const value = input as IpcInvokeMap[typeof IpcChannels.marketplaceAddSource]["args"][0]
            return service.marketplaceAddSource({ url: value.url })
          },
        },
        {
          channel: IpcChannels.marketplaceSetSourceEnabled,
          handler: (event, input) => {
            const value =
              input as IpcInvokeMap[typeof IpcChannels.marketplaceSetSourceEnabled]["args"][0]
            return service.marketplaceSetSourceEnabled({
              sourceId: value.sourceId,
              enabled: value.enabled,
            })
          },
        },
        {
          channel: IpcChannels.marketplaceRemoveSource,
          handler: (event, input) => {
            const value =
              input as IpcInvokeMap[typeof IpcChannels.marketplaceRemoveSource]["args"][0]
            return service.marketplaceRemoveSource({ sourceId: value.sourceId })
          },
        },
        {
          channel: IpcChannels.marketplacePreview,
          handler: (event, input) => {
            const value = input as IpcInvokeMap[typeof IpcChannels.marketplacePreview]["args"][0]
            return service.marketplace.preview(event.sender, {
              cwd: value.cwd,
              sourceId: value.sourceId,
              pluginId: value.pluginId,
              version: value.version,
            })
          },
        },
        {
          channel: IpcChannels.marketplaceConfirm,
          handler: (event, input) => {
            const value = input as IpcInvokeMap[typeof IpcChannels.marketplaceConfirm]["args"][0]
            return service.marketplace.confirm(event.sender, {
              cwd: value.cwd,
              selectionId: value.selectionId,
            })
          },
        },
        {
          channel: IpcChannels.marketplaceCancel,
          handler: (event, input) => {
            const value = input as IpcInvokeMap[typeof IpcChannels.marketplaceCancel]["args"][0]
            return service.marketplace.cancel(event.sender, { selectionId: value.selectionId })
          },
        },
        {
          channel: IpcChannels.marketplaceOperation,
          handler: (event, input) => {
            const value = input as IpcInvokeMap[typeof IpcChannels.marketplaceOperation]["args"][0]
            return service.marketplace.query(event.sender, {
              cwd: value.cwd,
              operationId: value.operationId,
            })
          },
        },

        {
          channel: IpcChannels.pluginLoadIcon,
          handler: (_event, input) => service.loadIcon(input as { src: string }),
        },
        {
          channel: IpcChannels.pluginSnapshot,
          handler: (_event, input) => service.snapshot(input as DesktopPluginContextInput),
        },
        {
          channel: IpcChannels.pluginEnable,
          handler: (_event, input) => service.enable(input as DesktopPluginActionInput),
        },
        {
          channel: IpcChannels.pluginDisable,
          handler: (_event, input) => service.disable(input as DesktopPluginActionInput),
        },
        {
          channel: IpcChannels.pluginUninstall,
          handler: (_event, input) => service.uninstall(input as DesktopPluginActionInput),
        },
        {
          channel: IpcChannels.pluginReload,
          handler: (_event, input) => service.reload(input as DesktopPluginContextInput),
        },
        {
          channel: IpcChannels.pluginImportArchive,
          handler: (event, input) => {
            const value = input as DesktopPluginArchiveImportInput
            return service.importArchive(event.sender, {
              cwd: value.cwd,
              ...(value.bundledPlugin !== undefined ? { bundledPlugin: value.bundledPlugin } : {}),
            })
          },
        },
        {
          channel: IpcChannels.pluginConfirmArchive,
          handler: (_event, input) => {
            const value = input as DesktopPluginArchiveConfirmInput
            return service.confirmArchive({ cwd: value.cwd, selectionId: value.selectionId })
          },
        },
        {
          channel: IpcChannels.pluginCancelArchive,
          handler: (_event, input) =>
            service.cancelArchive({
              selectionId: (input as DesktopPluginArchiveCancelInput).selectionId,
            }),
        },
        {
          channel: IpcChannels.pluginImportGit,
          handler: (_event, input) => {
            const value = input as DesktopPluginGitImportInput
            return service.importGit({ cwd: value.cwd, url: value.url, ref: value.ref })
          },
        },
        {
          channel: IpcChannels.pluginConfirmGit,
          handler: (_event, input) => {
            const value = input as DesktopPluginArchiveConfirmInput
            return service.confirmGit({ cwd: value.cwd, selectionId: value.selectionId })
          },
        },
        {
          channel: IpcChannels.pluginCancelGit,
          handler: (_event, input) =>
            service.cancelGit({
              selectionId: (input as DesktopPluginArchiveCancelInput).selectionId,
            }),
        },
      ]
    },
  }
}

export const pluginIpcContribution = createPluginIpcContribution(desktopPluginService)

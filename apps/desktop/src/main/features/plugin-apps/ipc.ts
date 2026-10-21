import { IpcChannels } from "../../../shared/ipc-channels"
import type { IpcContribution } from "../../core/ipc/types"
import { requireDesktopPluginAppService } from "./service-runtime"
import { PluginAppBusyError } from "./plugin-app-service"
export function createPluginAppsIpcContribution(
  getService = requireDesktopPluginAppService
): IpcContribution {
  return {
    id: "plugin-apps",
    register: () =>
      (
        [
          ["prepareMessage", IpcChannels.pluginAppsPrepareMessage],
          ["submitMessage", IpcChannels.pluginAppsSubmitMessage],
          ["getMessageSubmission", IpcChannels.pluginAppsGetMessageSubmission],
          ["cancelMessage", IpcChannels.pluginAppsCancelMessage],
          ["updateModelContext", IpcChannels.pluginAppsUpdateModelContext],
          ["catalog", IpcChannels.pluginAppsCatalog],
          ["open", IpcChannels.pluginAppsOpen],
          ["mount", IpcChannels.pluginAppsMount],
          ["openToolResult", IpcChannels.pluginAppsOpenToolResult],
          ["refresh", IpcChannels.pluginAppsRefresh],
          ["prepareTool", IpcChannels.pluginAppsPrepareTool],
          ["invokeTool", IpcChannels.pluginAppsInvokeTool],
          ["getAction", IpcChannels.pluginAppsGetAction],
          ["cancelTool", IpcChannels.pluginAppsCancelTool],
          ["readResource", IpcChannels.pluginAppsReadResource],
          ["listResources", IpcChannels.pluginAppsListResources],
          ["listResourceTemplates", IpcChannels.pluginAppsListResourceTemplates],
          ["close", IpcChannels.pluginAppsClose],
          ["rejectMenuOpen", IpcChannels.pluginAppsRejectMenuOpen],
          ["release", IpcChannels.pluginAppsRelease],
        ] as const
      ).map(([method, channel]) => ({
        channel,
        handler: (event, value) => {
          const service = getService()
          if (
            event.sender.isDestroyed() ||
            !event.senderFrame ||
            event.senderFrame !== event.sender.mainFrame ||
            !service.isOwner(event.sender.id)
          )
            throw new Error("plugin_app_owner_unavailable")
          const result = service[method](event.sender.id, value)
          if (method !== "invokeTool") return result
          // Electron discards Error fields. Carry only this Main-owned, verified rejection as data.
          return Promise.resolve(result).catch((error) => {
            if (error instanceof PluginAppBusyError)
              return { code: "plugin_app_busy", notAccepted: true, requestId: error.requestId }
            throw error
          })
        },
      })),
  }
}
export const pluginAppsIpcContribution = createPluginAppsIpcContribution()

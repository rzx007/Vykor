import { IpcChannels } from "../../../shared/ipc-channels"
import type {
  DesktopFeishuAllowInput,
  DesktopFeishuConnectInput,
  DesktopFeishuPatchInput,
  DesktopFeishuRegistrationStartInput,
} from "../../../shared/channel-types"
import type { IpcContribution } from "../../core/ipc/types"
import { desktopChannelService } from "./channel-service"

export const channelIpcContribution: IpcContribution = {
  id: "connections",
  register() {
    return [
      {
        channel: IpcChannels.connectionsSnapshot,
        handler: () => desktopChannelService.snapshot(),
      },
      {
        channel: IpcChannels.connectionsRuntimeStatus,
        handler: () => desktopChannelService.runtimeStatus(),
      },
      {
        channel: IpcChannels.connectionsFeishuConnect,
        handler: (_event, input) =>
          desktopChannelService.connect(input as DesktopFeishuConnectInput),
      },
      {
        channel: IpcChannels.connectionsFeishuPatch,
        handler: (_event, input) =>
          desktopChannelService.patch(input as DesktopFeishuPatchInput),
      },
      {
        channel: IpcChannels.connectionsFeishuRemove,
        handler: () => desktopChannelService.remove(),
      },
      {
        channel: IpcChannels.connectionsFeishuAllowAdd,
        handler: (_event, input) =>
          desktopChannelService.allowAdd(input as DesktopFeishuAllowInput),
      },
      {
        channel: IpcChannels.connectionsFeishuAllowRemove,
        handler: (_event, key) => desktopChannelService.allowRemove(key as string),
      },
      {
        channel: IpcChannels.connectionsFeishuRegistrationStart,
        handler: (_event, input) =>
          desktopChannelService.startRegistration(
            (input as DesktopFeishuRegistrationStartInput | undefined) ?? {}
          ),
      },
      {
        channel: IpcChannels.connectionsFeishuRegistrationStatus,
        handler: () => desktopChannelService.registrationStatus(),
      },
      {
        channel: IpcChannels.connectionsFeishuRegistrationCancel,
        handler: () => desktopChannelService.cancelRegistration(),
      },
      {
        channel: IpcChannels.connectionsRuntimeStart,
        handler: () => desktopChannelService.startRuntime(),
      },
      {
        channel: IpcChannels.connectionsRuntimeStop,
        handler: () => desktopChannelService.stopRuntime(),
      },
    ]
  },
}

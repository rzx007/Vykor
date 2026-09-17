import { IpcChannels } from "../../../shared/ipc-channels"
import type {
  ActivateDesktopProviderInput,
  ConnectDesktopProviderInput,
  DisconnectDesktopProviderInput,
  CreateDesktopCustomProviderInput,
  UpdateDesktopCatalogProviderHeadersInput,
  UpdateDesktopCustomProviderInput,
  RemoveDesktopCustomProviderInput,
} from "../../../shared/provider-types"
import type { IpcContribution } from "../../core/ipc/types"
import { desktopProviderService } from "./provider-service"

export const providerIpcContribution: IpcContribution = {
  id: "provider",
  register() {
    return [
      { channel: IpcChannels.providerSnapshot, handler: () => desktopProviderService.snapshot() },
      {
        channel: IpcChannels.providerConnect,
        handler: (_event, input) =>
          desktopProviderService.connect(input as ConnectDesktopProviderInput),
      },
      {
        channel: IpcChannels.providerActivate,
        handler: (_event, input) =>
          desktopProviderService.activate(input as ActivateDesktopProviderInput),
      },
      {
        channel: IpcChannels.providerDisconnect,
        handler: (_event, input) =>
          desktopProviderService.disconnect(input as DisconnectDesktopProviderInput),
      },
      {
        channel: IpcChannels.providerCatalogHeadersUpdate,
        handler: (_event, input) =>
          desktopProviderService.updateCatalogHeaders(
            input as UpdateDesktopCatalogProviderHeadersInput
          ),
      },
      {
        channel: IpcChannels.providerCustomCreate,
        handler: (_event, input) =>
          desktopProviderService.createCustom(input as CreateDesktopCustomProviderInput),
      },
      {
        channel: IpcChannels.providerCustomUpdate,
        handler: (_event, input) =>
          desktopProviderService.updateCustom(input as UpdateDesktopCustomProviderInput),
      },
      {
        channel: IpcChannels.providerCustomRemove,
        handler: (_event, input) =>
          desktopProviderService.removeCustom(input as RemoveDesktopCustomProviderInput),
      },
    ]
  },
}

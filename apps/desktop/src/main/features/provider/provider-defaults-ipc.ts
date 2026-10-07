import { ProviderDefaultsChannels, type UpdateProviderDefaultEffortInput } from "../../../shared/provider-defaults-types"
import type { IpcContribution } from "../../core/ipc/types"
import { desktopProviderDefaultsService as service } from "./provider-defaults-service"

export const providerDefaultsIpcContribution: IpcContribution = {
  id: "provider-defaults", register() { return [
    { channel: ProviderDefaultsChannels.snapshot, handler: () => service.snapshot() },
    { channel: ProviderDefaultsChannels.updateEffort, handler: (_event, input) => service.updateEffort(input as UpdateProviderDefaultEffortInput) },
    { channel: ProviderDefaultsChannels.test, handler: (_event, input) => service.test(input as { provider: string; model: string }) },
  ] },
}

import {
  PersonalizationManagementChannels,
  type PersonalizationManagementAPI,
} from "../../../shared/personalization-management-types"
import type { IpcContribution } from "../../core/ipc/types"
import { personalizationManagementService as service } from "./personalization-management-service"
export const personalizationManagementIpcContribution: IpcContribution = {
  id: "personalization-management",
  register() {
    return [
      {
        channel: PersonalizationManagementChannels.snapshot,
        handler: (_event, input) =>
          service.snapshot(input as Parameters<PersonalizationManagementAPI["snapshot"]>[0]),
      },
      {
        channel: PersonalizationManagementChannels.updateConfiguration,
        handler: (_event, input) =>
          service.updateConfiguration(
            input as Parameters<PersonalizationManagementAPI["updateConfiguration"]>[0]
          ),
      },
      {
        channel: PersonalizationManagementChannels.updateEntry,
        handler: (_event, input) =>
          service.updateEntry(input as Parameters<PersonalizationManagementAPI["updateEntry"]>[0]),
      },
      {
        channel: PersonalizationManagementChannels.removeEntry,
        handler: (_event, input) =>
          service.removeEntry(input as Parameters<PersonalizationManagementAPI["removeEntry"]>[0]),
      },
      {
        channel: PersonalizationManagementChannels.clearEntries,
        handler: (_event, input) =>
          service.clearEntries(
            input as Parameters<PersonalizationManagementAPI["clearEntries"]>[0]
          ),
      },
      {
        channel: PersonalizationManagementChannels.openRule,
        handler: (_event, input) =>
          service.openRule(input as Parameters<PersonalizationManagementAPI["openRule"]>[0]),
      },
      {
        channel: PersonalizationManagementChannels.openDirectory,
        handler: (_event, input) =>
          service.openDirectory(
            input as Parameters<PersonalizationManagementAPI["openDirectory"]>[0]
          ),
      },
    ]
  },
}

import { ConfigurationSettingsChannels, type ConfigurationSettingsAPI } from "../../../shared/configuration-settings-types"
import type { IpcContribution } from "../../core/ipc/types"
import { configurationSettingsService as service } from "./configuration-settings-service"
export const configurationSettingsIpcContribution: IpcContribution = { id: "configuration-settings", register: () => [
  { channel: ConfigurationSettingsChannels.review, handler: () => service.review() },
  { channel: ConfigurationSettingsChannels.updateReview, handler: (_event, input) => service.updateReview(input as Parameters<ConfigurationSettingsAPI["updateReview"]>[0]) },
  { channel: ConfigurationSettingsChannels.exportFile, handler: (_event, input) => service.exportFile(input as string[]) },
  { channel: ConfigurationSettingsChannels.previewImport, handler: () => service.previewImport() },
  { channel: ConfigurationSettingsChannels.applyImport, handler: (_event, input) => service.applyImport(input as Parameters<ConfigurationSettingsAPI["applyImport"]>[0]) },
] }

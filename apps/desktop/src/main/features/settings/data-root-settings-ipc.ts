import { MaintenanceSettingsChannels as channels } from "../../../shared/maintenance-settings-types"
import type { IpcContribution } from "../../core/ipc/types"
import { dataRootInfo, inspectDesktopDataRoot, migrateDesktopDataRoot, recoverDesktopDataRoot } from "./data-root-settings-service"
export const dataRootSettingsIpcContribution: IpcContribution = { id: "data-root-settings", register: () => [
  { channel: channels.dataRootInfo, handler: () => dataRootInfo() },
  { channel: channels.inspectDataRoot, handler: (_event, target) => inspectDesktopDataRoot(target as string) },
  { channel: channels.migrateDataRoot, handler: (_event, target) => migrateDesktopDataRoot(target as string) },
  { channel: channels.recoverDataRoot, handler: (_event, journal) => recoverDesktopDataRoot(journal as string) },
] }

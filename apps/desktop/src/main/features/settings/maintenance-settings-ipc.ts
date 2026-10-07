import { MaintenanceSettingsChannels as channels } from "../../../shared/maintenance-settings-types"
import type { DiagnosticFilter, UsageFilter, UsagePrice, UsageSettings } from "../../../shared/maintenance-settings-types"
import type { IpcContribution } from "../../core/ipc/types"
import { desktopMaintenanceSettingsService as service } from "./maintenance-settings-service"

export const maintenanceSettingsIpcContribution: IpcContribution = { id: "maintenance-settings", register() { service.startBudgetMonitor(); return [
  { channel: channels.storagePolicy, handler: () => service.storagePolicy() },
  { channel: channels.updateStoragePolicy, handler: (_event, input) => service.updateStoragePolicy(input as Parameters<typeof service.updateStoragePolicy>[0]) },
  { channel: channels.cleanupPreview, handler: (_event, input) => service.cleanupPreview(input as Parameters<typeof service.cleanupPreview>[0]) },
  { channel: channels.cleanupExecute, handler: (_event, input) => service.cleanupExecute(input as Parameters<typeof service.cleanupExecute>[0]) },
  { channel: channels.cleanupAudits, handler: () => service.cleanupAudits() },
  { channel: channels.diagnosticDetails, handler: () => service.diagnosticDetails() },
  { channel: channels.updateDiagnosticDetails, handler: (_event, minutes) => service.updateDiagnosticDetails(minutes as number) },
  { channel: channels.usage, handler: (_event, filter) => service.usage(filter as UsageFilter) },
  { channel: channels.price, handler: (_event, price) => service.price(price as Omit<UsagePrice, "adoptedAt">) },
  { channel: channels.budget, handler: (_event, budget) => service.budget(budget as UsageSettings["budget"]) },
  { channel: channels.exportUsage, handler: (_event, filter, format) => service.exportUsage(filter as UsageFilter, format as "csv" | "json") },
  { channel: channels.storage, handler: () => service.storage() }, { channel: channels.openDirectory, handler: () => service.openDirectory() },
  { channel: channels.chooseDirectory, handler: () => service.chooseDirectory() },
  { channel: channels.backup, handler: (_event, input) => service.backup(input as Parameters<typeof service.backup>[0]) },
  { channel: channels.verifyBackup, handler: (_event, source) => service.verifyBackup(source as string) },
  { channel: channels.restore, handler: (_event, input) => service.restore(input as Parameters<typeof service.restore>[0]) },
  { channel: channels.switchData, handler: (_event, directory) => service.switchData(directory as string) },
  { channel: channels.diagnose, handler: (_event, input) => service.diagnose(input as Parameters<typeof service.diagnose>[0]) }, { channel: channels.cancelDiagnosis, handler: (_event, input) => service.cancelDiagnosis(input as Parameters<typeof service.cancelDiagnosis>[0]) },
  { channel: channels.exportDiagnostics, handler: (_event, filter, kind) => service.exportDiagnostics(filter as DiagnosticFilter, kind as "diagnostics" | "logs") },
  { channel: channels.reconnect, handler: () => service.reconnect() }, { channel: channels.restart, handler: () => service.restart() },
] } }

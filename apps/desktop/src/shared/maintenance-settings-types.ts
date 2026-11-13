import type { MaintenanceBackupManifest, CleanupPreview, CleanupResult, StorageReport, StorageRetentionPolicy, UsageFilter, UsagePrice, UsageReport, UsageSettings } from "@vykor/application-client"
export type { CleanupPreview, CleanupResult, StorageReport, StorageRetentionPolicy, UsageFilter, UsagePrice, UsageReport, UsageSettings }
export interface MaintenanceBackupResult { path: string; manifest: MaintenanceBackupManifest; totalBytes?: number; excludes?: string[]; settingsExcluded?: boolean; settingsSnapshotPath?: string }
export interface DiagnosticCheck { id: string; name: string; status: "success" | "warning" | "failed" | "unsupported" | "timeout" | "cancelled"; detail: string }
export interface DiagnosticLog { time: number; level: string; module: string; event: string; runId?: string; sessionId?: string; traceId?: string; status?: string; durationMs?: number; requestId?: string; toolName?: string; method?: string }
export interface DiagnosticReport { checkedAt: number; desktopVersion: string; platform: string; architecture: string; target: string | null; checks: DiagnosticCheck[]; logs: DiagnosticLog[]; missing: string[]; activeWork?: { runs: Array<{ id: string; sessionId: string; status: string }>; tasks: Array<{ id: string; sessionId: string; status: string }>; terminals: Array<{ id: string; status: string }> } }
export interface DiagnosticFilter { from?: number; level?: string; module?: string; runId?: string; query?: string }
export interface DiagnosisRequest { requestId: string }
export interface DataRootInfo { currentRoot: string; source: string; retainedProfile: string; unresolvedComposer: { count: number; reason: "session-not-found"; sourceDigest: string } | null }
export interface DataRootPreview { sourceRoot: string; targetRoot: string; files: number; bytes: number; blockers: Array<{ code: string; path?: string; message: string }>; entries: Array<{ source: string; target: string; kind: string; bytes: number }>; impacts: string[]; requiredValidations: string[] }
export interface DataRootOperation { phase: string; operation?: string; failedOperation?: string; journalPath?: string; usableRoot: string; startup?: string; error?: string }
export const MaintenanceSettingsChannels = {
  dataRootInfo: "settings:maintenance:data-root-info", inspectDataRoot: "settings:maintenance:inspect-data-root", migrateDataRoot: "settings:maintenance:migrate-data-root", recoverDataRoot: "settings:maintenance:recover-data-root",
  usage: "settings:maintenance:usage", price: "settings:maintenance:price", budget: "settings:maintenance:budget", exportUsage: "settings:maintenance:export-usage",
  storage: "settings:maintenance:storage", openDirectory: "settings:maintenance:open-directory", chooseDirectory: "settings:maintenance:choose-directory",
  backup: "settings:maintenance:backup", verifyBackup: "settings:maintenance:verify-backup", restore: "settings:maintenance:restore", switchData: "settings:maintenance:switch-data",
  diagnose: "settings:maintenance:diagnose", cancelDiagnosis: "settings:maintenance:cancel-diagnosis", exportDiagnostics: "settings:maintenance:export-diagnostics", reconnect: "settings:maintenance:reconnect", restart: "settings:maintenance:restart",
  cleanupPreview: "settings:maintenance:cleanup-preview", cleanupExecute: "settings:maintenance:cleanup-execute", cleanupAudits: "settings:maintenance:cleanup-audits", diagnosticDetails: "settings:maintenance:diagnostic-details", updateDiagnosticDetails: "settings:maintenance:update-diagnostic-details",
  storagePolicy: "settings:maintenance:storage-policy", updateStoragePolicy: "settings:maintenance:update-storage-policy",
} as const
export interface MaintenanceSettingsIpcMap {
  [MaintenanceSettingsChannels.dataRootInfo]: { args: []; result: DataRootInfo }
  [MaintenanceSettingsChannels.inspectDataRoot]: { args: [string]; result: DataRootPreview }
  [MaintenanceSettingsChannels.migrateDataRoot]: { args: [string]; result: DataRootOperation }
  [MaintenanceSettingsChannels.recoverDataRoot]: { args: [string]; result: DataRootOperation }
  [MaintenanceSettingsChannels.storagePolicy]: { args: []; result: StorageRetentionPolicy }
  [MaintenanceSettingsChannels.updateStoragePolicy]: { args: [{ enabled: boolean; days: number; expected: { enabled: boolean; days: number } }]; result: StorageRetentionPolicy }
  [MaintenanceSettingsChannels.cleanupPreview]: { args: [{ kind: "session" | "log"; olderThan: number }]; result: CleanupPreview }
  [MaintenanceSettingsChannels.cleanupExecute]: { args: [{ previewId: string; ids: string[] }]; result: CleanupResult }
  [MaintenanceSettingsChannels.cleanupAudits]: { args: []; result: { audits: Record<string, unknown>[] } }
  [MaintenanceSettingsChannels.diagnosticDetails]: { args: []; result: { expiresAt: number | null } }
  [MaintenanceSettingsChannels.updateDiagnosticDetails]: { args: [number]; result: { expiresAt: number | null } }
  [MaintenanceSettingsChannels.usage]: { args: [UsageFilter]; result: UsageReport }
  [MaintenanceSettingsChannels.price]: { args: [Omit<UsagePrice, "adoptedAt">]; result: UsageSettings }
  [MaintenanceSettingsChannels.budget]: { args: [UsageSettings["budget"] & { expected?: UsageSettings["budget"] }]; result: UsageSettings }
  [MaintenanceSettingsChannels.exportUsage]: { args: [UsageFilter, "csv" | "json"]; result: string | null }
  [MaintenanceSettingsChannels.storage]: { args: []; result: StorageReport }
  [MaintenanceSettingsChannels.openDirectory]: { args: []; result: void }
  [MaintenanceSettingsChannels.chooseDirectory]: { args: []; result: string | null }
  [MaintenanceSettingsChannels.backup]: { args: [{ destination: string; includeMemory: boolean; includeOutput: boolean }]; result: MaintenanceBackupResult }
  [MaintenanceSettingsChannels.verifyBackup]: { args: [string]; result: MaintenanceBackupResult }
  [MaintenanceSettingsChannels.restore]: { args: [{ source: string; target: string }]; result: MaintenanceBackupResult }
  [MaintenanceSettingsChannels.switchData]: { args: [string]; result: void }
  [MaintenanceSettingsChannels.diagnose]: { args: [input?: DiagnosisRequest]; result: DiagnosticReport }
  [MaintenanceSettingsChannels.cancelDiagnosis]: { args: [input?: DiagnosisRequest]; result: void }
  [MaintenanceSettingsChannels.exportDiagnostics]: { args: [DiagnosticFilter, "diagnostics" | "logs"]; result: string | null }
  [MaintenanceSettingsChannels.reconnect]: { args: []; result: void }
  [MaintenanceSettingsChannels.restart]: { args: []; result: void }
}
export interface MaintenanceSettingsAPI {
  dataRootInfo(): Promise<DataRootInfo>
  inspectDataRoot(target: string): Promise<DataRootPreview>
  migrateDataRoot(target: string): Promise<DataRootOperation>
  recoverDataRoot(journal: string): Promise<DataRootOperation>
  storagePolicy(): Promise<StorageRetentionPolicy>
  updateStoragePolicy(input: { enabled: boolean; days: number; expected: { enabled: boolean; days: number } }): Promise<StorageRetentionPolicy>
  cleanupPreview(input: { kind: "session" | "log"; olderThan: number }): Promise<CleanupPreview>
  cleanupExecute(input: { previewId: string; ids: string[] }): Promise<CleanupResult>
  cleanupAudits(): Promise<{ audits: Record<string, unknown>[] }>
  diagnosticDetails(): Promise<{ expiresAt: number | null }>
  updateDiagnosticDetails(minutes: number): Promise<{ expiresAt: number | null }>
  usage(filter: UsageFilter): Promise<UsageReport>
  price(price: Omit<UsagePrice, "adoptedAt">): Promise<UsageSettings>
  budget(budget: UsageSettings["budget"] & { expected?: UsageSettings["budget"] }): Promise<UsageSettings>
  exportUsage(filter: UsageFilter, format: "csv" | "json"): Promise<string | null>
  storage(): Promise<StorageReport>
  openDirectory(): Promise<void>
  chooseDirectory(): Promise<string | null>
  backup(input: { destination: string; includeMemory: boolean; includeOutput: boolean }): Promise<MaintenanceBackupResult>
  verifyBackup(source: string): Promise<MaintenanceBackupResult>
  restore(input: { source: string; target: string }): Promise<MaintenanceBackupResult>
  switchData(directory: string): Promise<void>
  diagnose(input?: DiagnosisRequest): Promise<DiagnosticReport>
  cancelDiagnosis(input?: DiagnosisRequest): Promise<void>
  exportDiagnostics(filter: DiagnosticFilter, kind: "diagnostics" | "logs"): Promise<string | null>
  reconnect(): Promise<void>
  restart(): Promise<void>
}

export interface StorageRetentionPolicy { version: 1; enabled: boolean; days: number; lastRunAt: number | null }
export interface MaintenanceBackupManifest {
  version: 1 | 2 | 3; backupId: string; createdAt: number; database: "database.sqlite";
  directories: Record<"artifacts" | "memory" | "execution-output" | "attachments", boolean> & { notes?: boolean };
  attachments?: { assets: number; uniqueBlobs: number; physicalBytes: number; consistency: { errors: number; warnings: number; issueCounts: Record<string, number> } };
  recovery: { reviveLiveProcesses: false; closeActiveRecordsOnStartup: true };
}

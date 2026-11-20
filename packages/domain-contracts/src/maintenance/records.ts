export interface StorageRetentionPolicy { version: 1; enabled: boolean; days: number; lastRunAt: number | null }
type BackupDirectories = Record<"artifacts" | "memory" | "execution-output", boolean>;

interface BackupManifestFields {
  backupId: string; createdAt: number; database: "database.sqlite";
  attachments?: { assets: number; uniqueBlobs: number; physicalBytes: number; consistency: { errors: number; warnings: number; issueCounts: Record<string, number> } };
  recovery: { reviveLiveProcesses: false; closeActiveRecordsOnStartup: true };
}

export interface DaemonMaintenanceBackupManifest extends BackupManifestFields {
  version: 4;
  scope: "daemon-only";
  directories: BackupDirectories & { attachments: boolean; notes?: never };
}

export type MaintenanceBackupManifest = DaemonMaintenanceBackupManifest | (BackupManifestFields & {
  version: 1 | 2 | 3;
  directories: BackupDirectories & { attachments?: boolean; notes?: boolean };
});

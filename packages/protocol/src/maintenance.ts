/** Maintenance wire values contain no runtime objects, credentials or message content. */
export interface UsageFilter { from?: number; to?: number; project?: string; provider?: string; model?: string }
export interface UsageRequest {
  id: string; time: number; project: string; sessionId: string; runId: string;
  provider: string; model: string; status: string; completeness: "complete" | "partial" | "unknown";
  inputTokens: number | null; outputTokens: number | null; cacheReadTokens: number | null; cacheCreationTokens: number | null;
  cost: { amount: number; currency: string; kind: "estimate"; source: string; adoptedAt: number; price: UsagePrice } | null;
  subscription?: true;
}
export interface UsagePrice {
  provider: string; model: string; currency: string; source: string; adoptedAt: number;
  inputPerMillion: number; outputPerMillion: number; cacheReadPerMillion: number; cacheCreationPerMillion: number; subscription: boolean;
  inputIncludesCache?: boolean;
}
export interface UsageSettings { version: 1; prices: UsagePrice[]; budget: { enabled: boolean; tokens: number | null; amount: number | null; currency: string } }
export interface UsageReport {
  scannedAt: number; requests: UsageRequest[]; warnings: string[]; options: { projects: string[]; providers: string[]; models: string[] };
  totals: { requests: number; unknown: number; partial: number; input: number; output: number; cacheRead: number; cacheCreation: number; costs: Record<string, number> }; settings: UsageSettings;
}
export interface StorageCategory { id: string; name: string; paths: string[]; bytes: number; files: number; errors: string[] }
export interface StorageReport { scannedAt: number; dataDirectory: string; totalBytes: number; availableBytes: number | null; writable: boolean; categories: StorageCategory[]; backups?: Array<{ path: string; createdAt: number; bytes: number; manifest: MaintenanceBackupManifest }> }
export interface CleanupCandidate { id: string; kind: "session" | "log"; label: string; updatedAt: number; bytes: number; children?: number; attachments?: number }
export interface CleanupPreview { id: string; createdAt: number; olderThan: number; candidates: CleanupCandidate[]; protected: Array<{ id: string; reason: string }>; bytes: number; scope: string }
export interface CleanupResult { auditId: string; completed: string[]; skipped: Array<{ id: string; reason: string }>; failures: Array<{ id: string; reason: string }>; releasedBytes: number }
export interface StorageRetentionPolicy { version: 1; enabled: boolean; days: number; lastRunAt: number | null }
export interface MaintenanceBackupManifest {
  version: 1 | 2 | 3; backupId: string; createdAt: number; database: "database.sqlite";
  directories: Record<"artifacts" | "memory" | "execution-output" | "attachments", boolean> & { notes?: boolean };
  attachments?: { assets: number; uniqueBlobs: number; physicalBytes: number; consistency: { errors: number; warnings: number; issueCounts: Record<string, number> } };
  recovery: { reviveLiveProcesses: false; closeActiveRecordsOnStartup: true };
}

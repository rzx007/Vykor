/** Maintenance queries own their internal result models. */
import type { UsagePrice, UsageSettings } from "@vykor/domain-contracts/usage";
import type { StorageRetentionPolicy, MaintenanceBackupManifest } from "@vykor/domain-contracts/maintenance";
export interface UsageFilter { from?: number; to?: number; project?: string; provider?: string; model?: string }

export interface UsageRequest {
  id: string; time: number; project: string; sessionId: string; runId: string;
  provider: string; model: string; status: string; completeness: "complete" | "partial" | "unknown";
  inputTokens: number | null; outputTokens: number | null; cacheReadTokens: number | null; cacheCreationTokens: number | null;
  cost: { amount: number; currency: string; kind: "estimate"; source: string; adoptedAt: number; price: UsagePrice } | null;
  subscription?: true;
}

export interface UsageReport {
  scannedAt: number; requests: UsageRequest[]; warnings: string[]; options: { projects: string[]; providers: string[]; models: string[] };
  totals: { requests: number; unknown: number; partial: number; input: number; output: number; cacheRead: number; cacheCreation: number; costs: Record<string, number> }; settings: UsageSettings;
}

export interface StorageCategory { id: string; name: string; paths: string[]; bytes: number; files: number; errors: string[] }

export interface StorageReport { scannedAt: number; dataDirectory: string; totalBytes: number; availableBytes: number | null; writable: boolean; categories: StorageCategory[]; backups?: Array<{ path: string; createdAt: number; bytes: number; manifest: MaintenanceBackupManifest }> }

export interface CleanupCandidate { id: string; kind: "session" | "log"; label: string; updatedAt: number; bytes: number; children?: number; attachments?: number }

export interface CleanupPreview { id: string; createdAt: number; olderThan: number; candidates: CleanupCandidate[]; protected: Array<{ id: string; reason: string }>; bytes: number; scope: string }

export interface CleanupResult { auditId: string; completed: string[]; skipped: Array<{ id: string; reason: string }>; failures: Array<{ id: string; reason: string }>; releasedBytes: number }
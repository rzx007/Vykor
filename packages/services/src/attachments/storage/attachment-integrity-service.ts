import type { AttachmentAssetRecord } from "@openharness/protocol";

import type {
  AttachmentLeaseRecord,
  SessionStore,
} from "../../session-runtime/store.js";
import type {
  AttachmentBlobStore,
  StoredAttachmentBlob,
} from "./attachment-blob-store.js";
import { AttachmentStorageOperationGate } from "./attachment-storage-operation-gate.js";

export type AttachmentIntegrityIssueCode =
  | "missing_blob"
  | "size_mismatch"
  | "orphan_blob"
  | "stale_lease"
  | "deleted_asset_retained";

export interface AttachmentIntegrityIssue {
  code: AttachmentIntegrityIssueCode;
  severity: "warning" | "error";
  assetId?: string;
  sha256?: string;
  expectedSizeBytes?: number;
  actualSizeBytes?: number;
  collectible?: boolean;
}

export interface AttachmentIntegrityReport {
  summary: {
    assets: Record<AttachmentAssetRecord["status"], number>;
    uniqueBlobs: number;
    physicalBytes: number;
    logicalBytes: number;
    deduplicatedBytes: number;
    activeLeases: number;
    expiredLeases: number;
    reclaimableBytes: number;
  };
  issues: AttachmentIntegrityIssue[];
  latestGcAudit?: {
    id: string;
    policy: string;
    result: unknown;
    createdAt: number;
  };
}

export interface AttachmentGcResult {
  scannedAssets: number;
  expiredLeases: number;
  deletedAssets: number;
  deletedBlobs: number;
  releasedBytes: number;
  skipped: {
    notDeleted: number;
    gracePeriod: number;
    missingHash: number;
    referenced: number;
    activeLease: number;
    sharedBlob: number;
  };
  errors: Array<{ assetId: string; code: "blob_delete_failed" }>;
}

export class AttachmentIntegrityService {
  private runningGc = false;
  private readonly operationGate: AttachmentStorageOperationGate;

  constructor(
    private readonly options: {
      store: Pick<SessionStore, "latestRetentionAudit" | "recordRetentionAudit">;
      attachments: Pick<SessionStore["attachments"],
        | "listAttachments"
        | "listAttachmentLeases"
        | "listActiveAttachmentLeases"
        | "deleteExpiredAttachmentLeases"
        | "countAttachmentReferences"
        | "purgeDeletedAttachment"
      >;
      blobs: AttachmentBlobStore;
      now?: () => number;
      operationGate?: AttachmentStorageOperationGate;
    },
  ) {
    this.operationGate = options.operationGate ?? new AttachmentStorageOperationGate();
  }

  async scan(input: { gracePeriodMs: number }): Promise<AttachmentIntegrityReport> {
    const now = this.now();
    validateGracePeriod(input.gracePeriodMs);
    const assets = this.options.attachments.listAttachments({ includeDeleted: true });
    const blobs = await this.options.blobs.listBlobs();
    const blobByHash = new Map(blobs.map((blob) => [blob.sha256, blob]));
    const assetsByHash = groupAssetsByHash(assets);
    const leases = this.options.attachments.listAttachmentLeases();
    const activeLeases = leases.filter((lease) => lease.expiresAt > now);
    const issues: AttachmentIntegrityIssue[] = [];

    for (const asset of assets) {
      if (!asset.sha256 || asset.sizeBytes === undefined) continue;
      const blob = blobByHash.get(asset.sha256);
      if (!blob) {
        issues.push({
          code: "missing_blob",
          severity: "error",
          assetId: asset.id,
          sha256: asset.sha256,
          expectedSizeBytes: asset.sizeBytes,
        });
      } else if (blob.sizeBytes !== asset.sizeBytes) {
        issues.push({
          code: "size_mismatch",
          severity: "error",
          assetId: asset.id,
          sha256: asset.sha256,
          expectedSizeBytes: asset.sizeBytes,
          actualSizeBytes: blob.sizeBytes,
        });
      }
      if (
        asset.status === "deleted" &&
        asset.deletedAt !== undefined &&
        asset.deletedAt + input.gracePeriodMs <= now
      ) {
        issues.push({
          code: "deleted_asset_retained",
          severity: "warning",
          assetId: asset.id,
          sha256: asset.sha256,
          collectible: this.isCollectible(asset, activeLeases, now),
        });
      }
    }
    for (const blob of blobs) {
      if (!assetsByHash.has(blob.sha256)) {
        issues.push({
          code: "orphan_blob",
          severity: "warning",
          sha256: blob.sha256,
          actualSizeBytes: blob.sizeBytes,
          collectible: blob.modifiedAt + input.gracePeriodMs <= now,
        });
      }
    }
    for (const lease of leases) {
      if (lease.expiresAt <= now) {
        issues.push({
          code: "stale_lease",
          severity: "warning",
          assetId: lease.assetId,
          collectible: true,
        });
      }
    }

    const logicalBytes = assets
      .filter((asset) => asset.status === "ready")
      .reduce((total, asset) => total + (asset.sizeBytes ?? 0), 0);
    const physicalBytes = blobs.reduce((total, blob) => total + blob.sizeBytes, 0);
    const latestGcAudit = this.options.store.latestRetentionAudit("attachment_gc");
    return {
      summary: {
        assets: countAssetStatuses(assets),
        uniqueBlobs: blobs.length,
        physicalBytes,
        logicalBytes,
        deduplicatedBytes: Math.max(0, logicalBytes - physicalBytes),
        activeLeases: activeLeases.length,
        expiredLeases: leases.length - activeLeases.length,
        reclaimableBytes: issues
          .filter((issue) => issue.code === "orphan_blob" && issue.collectible)
          .reduce((total, issue) => total + (issue.actualSizeBytes ?? 0), 0),
      },
      issues: issues.sort(compareIssues),
      ...(latestGcAudit ? { latestGcAudit } : {}),
    };
  }

  async repairSafe(input: { gracePeriodMs: number }): Promise<{
    expiredLeases: number;
    deletedOrphanBlobs: number;
    releasedBytes: number;
  }> {
    return await this.operationGate.runExclusive(() => this.repairSafeUnlocked(input));
  }

  private async repairSafeUnlocked(input: { gracePeriodMs: number }): Promise<{
    expiredLeases: number;
    deletedOrphanBlobs: number;
    releasedBytes: number;
  }> {
    const now = this.now();
    const report = await this.scan(input);
    const expiredLeases = this.options.attachments.deleteExpiredAttachmentLeases(now);
    let deletedOrphanBlobs = 0;
    let releasedBytes = 0;
    for (const issue of report.issues) {
      if (issue.code !== "orphan_blob" || !issue.collectible || !issue.sha256) continue;
      const result = await this.options.blobs.deleteBlob(issue.sha256);
      if (result.deleted) deletedOrphanBlobs++;
      releasedBytes += result.sizeBytes;
    }
    return { expiredLeases, deletedOrphanBlobs, releasedBytes };
  }

  async gc(input: { gracePeriodMs: number }): Promise<AttachmentGcResult> {
    if (this.runningGc) throw new Error("attachment_gc_busy");
    this.runningGc = true;
    try {
      return await this.operationGate.runExclusive(() => this.gcUnlocked(input));
    } finally {
      this.runningGc = false;
    }
  }

  private async gcUnlocked(input: { gracePeriodMs: number }): Promise<AttachmentGcResult> {
    const now = this.now();
    validateGracePeriod(input.gracePeriodMs);
    const expiredLeases = this.options.attachments.deleteExpiredAttachmentLeases(now);
    let deletedAssets = 0;
    let deletedBlobs = 0;
    let releasedBytes = 0;
    const assets = this.options.attachments.listAttachments({ includeDeleted: true });
    const activeLeases = this.options.attachments.listActiveAttachmentLeases(now);
    const skipped: AttachmentGcResult["skipped"] = {
      notDeleted: 0,
      gracePeriod: 0,
      missingHash: 0,
      referenced: 0,
      activeLease: 0,
      sharedBlob: 0,
    };
    const errors: AttachmentGcResult["errors"] = [];
    for (const asset of assets) {
      if (asset.status !== "deleted") { skipped.notDeleted++; continue; }
      if (asset.deletedAt === undefined || asset.deletedAt + input.gracePeriodMs > now) {
        skipped.gracePeriod++;
        continue;
      }
      if (!asset.sha256) { skipped.missingHash++; continue; }
      if (this.options.attachments.countAttachmentReferences(asset.id) > 0) {
        skipped.referenced++;
        continue;
      }
      if (activeLeases.some((lease) => lease.assetId === asset.id)) {
        skipped.activeLease++;
        continue;
      }
      const sharesInUse = assets.some((other) =>
        other.id !== asset.id &&
        other.sha256 === asset.sha256 &&
        (
          other.status === "ready" ||
          this.options.attachments.countAttachmentReferences(other.id) > 0 ||
          activeLeases.some((lease) => lease.assetId === other.id)
        )
      );
      if (!sharesInUse) {
        try {
          const result = await this.options.blobs.deleteBlob(asset.sha256);
          if (result.deleted) deletedBlobs++;
          releasedBytes += result.sizeBytes;
        } catch {
          errors.push({ assetId: asset.id, code: "blob_delete_failed" });
          continue;
        }
      } else {
        skipped.sharedBlob++;
      }
      if (this.options.attachments.purgeDeletedAttachment(asset.id, now)) {
        deletedAssets++;
      }
    }
    const result: AttachmentGcResult = {
      scannedAssets: assets.length,
      expiredLeases,
      deletedAssets,
      deletedBlobs,
      releasedBytes,
      skipped,
      errors,
    };
    this.options.store.recordRetentionAudit({
      policy: "attachment_gc",
      result,
      timestamp: now,
    });
    return result;
  }

  private isCollectible(
    asset: AttachmentAssetRecord,
    activeLeases: AttachmentLeaseRecord[],
    _timestamp: number,
  ): boolean {
    return this.options.attachments.countAttachmentReferences(asset.id) === 0 &&
      !activeLeases.some((lease) => lease.assetId === asset.id);
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

}

function groupAssetsByHash(assets: AttachmentAssetRecord[]): Map<string, AttachmentAssetRecord[]> {
  const grouped = new Map<string, AttachmentAssetRecord[]>();
  for (const asset of assets) {
    if (!asset.sha256) continue;
    const group = grouped.get(asset.sha256) ?? [];
    group.push(asset);
    grouped.set(asset.sha256, group);
  }
  return grouped;
}

function countAssetStatuses(
  assets: AttachmentAssetRecord[],
): Record<AttachmentAssetRecord["status"], number> {
  const counts = { importing: 0, ready: 0, failed: 0, deleted: 0 };
  for (const asset of assets) counts[asset.status]++;
  return counts;
}

function compareIssues(left: AttachmentIntegrityIssue, right: AttachmentIntegrityIssue): number {
  return left.code.localeCompare(right.code) ||
    (left.assetId ?? left.sha256 ?? "").localeCompare(right.assetId ?? right.sha256 ?? "");
}

function validateGracePeriod(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Attachment grace period must be a non-negative safe integer");
  }
}

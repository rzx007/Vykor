export interface UploadAttachmentInput {
  displayName: string;
  mediaType?: string;
  body: Blob | ArrayBuffer | Uint8Array | ReadableStream<Uint8Array>;
  signal?: AbortSignal;
}

export interface DownloadAttachmentOptions {
  range?: {
    start?: number;
    end?: number;
    suffixBytes?: number;
  };
  signal?: AbortSignal;
}

export interface AttachmentStorageIssue {
  code:
    | "missing_blob"
    | "size_mismatch"
    | "orphan_blob"
    | "stale_lease"
    | "deleted_asset_retained";
  severity: "warning" | "error";
  assetId?: string;
  sha256?: string;
  expectedSizeBytes?: number;
  actualSizeBytes?: number;
  collectible?: boolean;
}

export interface AttachmentStorageReport {
  summary: {
    assets: Record<"importing" | "ready" | "failed" | "deleted", number>;
    uniqueBlobs: number;
    physicalBytes: number;
    logicalBytes: number;
    deduplicatedBytes: number;
    activeLeases: number;
    expiredLeases: number;
    reclaimableBytes: number;
  };
  issues: AttachmentStorageIssue[];
  latestGcAudit?: {
    id: string;
    policy: string;
    result: unknown;
    createdAt: number;
  };
}

export interface AttachmentStorageRepairResult {
  expiredLeases: number;
  deletedOrphanBlobs: number;
  releasedBytes: number;
}

export interface AttachmentStorageGcResult {
  scannedAssets: number;
  expiredLeases: number;
  deletedAssets: number;
  deletedBlobs: number;
  releasedBytes: number;
  skipped: Record<
    | "notDeleted"
    | "gracePeriod"
    | "missingHash"
    | "referenced"
    | "activeLease"
    | "sharedBlob",
    number
  >;
  errors: Array<{ assetId: string; code: "blob_delete_failed" }>;
}

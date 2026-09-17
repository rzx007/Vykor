import { parseAttachmentAssetRecord } from "@openharness/protocol";
import type {
  AttachmentAssetRecord,
  AttachmentRepresentationRecord,
  AttachmentRepresentationKind,
} from "@openharness/protocol";

export interface CreateAttachmentRepresentationInput {
  id: string;
  assetId: string;
  kind: AttachmentRepresentationKind;
  processor: string;
  processorVersion: string;
  cacheKey: string;
  mediaType: string;
  createdAt?: number;
}

export interface AttachmentLeaseRecord {
  id: string;
  assetId: string;
  ownerKind: "session_run" | "backup";
  ownerId: string;
  createdAt: number;
  renewedAt: number;
  expiresAt: number;
}

export interface AcquireAttachmentLeasesInput {
  assetIds: string[];
  ownerKind: AttachmentLeaseRecord["ownerKind"];
  ownerId: string;
  timestamp: number;
  expiresAt: number;
}

export interface CreateImportingAttachmentInput {
  id: string;
  displayName: string;
  declaredMediaType?: string;
  stagingName: string;
  createdAt?: number;
}

export interface MarkAttachmentReadyInput {
  sha256: string;
  sizeBytes: number;
  mediaType: string;
  updatedAt?: number;
}

export interface ImportingAttachmentRecord extends AttachmentAssetRecord {
  stagingName: string;
}

export function attachmentAssetFromRow(
  row: Record<string, unknown>,
): AttachmentAssetRecord {
  return parseAttachmentAssetRecord({
    id: row.id,
    displayName: row.display_name,
    ...(typeof row.declared_media_type === "string"
      ? { declaredMediaType: row.declared_media_type }
      : {}),
    ...(typeof row.media_type === "string"
      ? { mediaType: row.media_type }
      : {}),
    ...(typeof row.size_bytes === "number"
      ? { sizeBytes: row.size_bytes }
      : {}),
    ...(typeof row.sha256 === "string" ? { sha256: row.sha256 } : {}),
    status: row.status,
    ...(typeof row.failure_code === "string"
      ? { failureCode: row.failure_code }
      : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(typeof row.deleted_at === "number"
      ? { deletedAt: row.deleted_at }
      : {}),
  });
}

export function attachmentRepresentationFromRow(
  row: Record<string, unknown>,
): AttachmentRepresentationRecord {
  return {
    id: String(row.id),
    assetId: String(row.asset_id),
    kind: String(row.kind) as AttachmentRepresentationRecord["kind"],
    status: String(row.status) as AttachmentRepresentationRecord["status"],
    processor: String(row.processor),
    processorVersion: String(row.processor_version),
    cacheKey: String(row.cache_key),
    mediaType: String(row.media_type),
    ...(row.text !== null && row.text !== undefined
      ? { text: String(row.text) }
      : {}),
    ...(row.error !== null && row.error !== undefined
      ? { error: String(row.error) }
      : {}),
    metadata: JSON.parse(String(row.metadata_json) || "{}"),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export function attachmentLeaseFromRow(
  row: Record<string, unknown>,
): AttachmentLeaseRecord {
  return {
    id: String(row.id),
    assetId: String(row.asset_id),
    ownerKind: String(row.owner_kind) as AttachmentLeaseRecord["ownerKind"],
    ownerId: String(row.owner_id),
    createdAt: Number(row.created_at),
    renewedAt: Number(row.renewed_at),
    expiresAt: Number(row.expires_at),
  };
}

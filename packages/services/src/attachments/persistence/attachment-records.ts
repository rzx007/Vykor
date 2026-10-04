import { parseAttachmentAssetRecord } from "@vykor/protocol";
import type {
  AttachmentAssetRecord,
  AttachmentRepresentationRecord,
  AttachmentRepresentationKind,
} from "@vykor/protocol";
import type {
  attachmentAssets,
  attachmentLeases,
  attachmentRepresentations,
} from "../../session-runtime/schema.js";

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
  row: typeof attachmentAssets.$inferSelect,
): AttachmentAssetRecord {
  return parseAttachmentAssetRecord({
    id: row.id,
    displayName: row.displayName,
    ...(typeof row.declaredMediaType === "string"
      ? { declaredMediaType: row.declaredMediaType }
      : {}),
    ...(typeof row.mediaType === "string"
      ? { mediaType: row.mediaType }
      : {}),
    ...(typeof row.sizeBytes === "number"
      ? { sizeBytes: row.sizeBytes }
      : {}),
    ...(typeof row.sha256 === "string" ? { sha256: row.sha256 } : {}),
    status: row.status,
    ...(typeof row.failureCode === "string"
      ? { failureCode: row.failureCode }
      : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(typeof row.deletedAt === "number"
      ? { deletedAt: row.deletedAt }
      : {}),
  });
}

export function attachmentRepresentationFromRow(
  row: typeof attachmentRepresentations.$inferSelect,
): AttachmentRepresentationRecord {
  return {
    id: String(row.id),
    assetId: String(row.assetId),
    kind: String(row.kind) as AttachmentRepresentationRecord["kind"],
    status: String(row.status) as AttachmentRepresentationRecord["status"],
    processor: String(row.processor),
    processorVersion: String(row.processorVersion),
    cacheKey: String(row.cacheKey),
    mediaType: String(row.mediaType),
    ...(row.text !== null && row.text !== undefined
      ? { text: String(row.text) }
      : {}),
    ...(row.error !== null && row.error !== undefined
      ? { error: String(row.error) }
      : {}),
    metadata: JSON.parse(String(row.metadataJson) || "{}"),
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
  };
}

export function attachmentLeaseFromRow(
  row: typeof attachmentLeases.$inferSelect,
): AttachmentLeaseRecord {
  return {
    id: String(row.id),
    assetId: String(row.assetId),
    ownerKind: String(row.ownerKind) as AttachmentLeaseRecord["ownerKind"],
    ownerId: String(row.ownerId),
    createdAt: Number(row.createdAt),
    renewedAt: Number(row.renewedAt),
    expiresAt: Number(row.expiresAt),
  };
}

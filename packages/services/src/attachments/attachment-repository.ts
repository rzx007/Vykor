import { randomUUID } from "node:crypto";
import type {
  AttachmentAssetRecord,
  AttachmentRepresentationRecord,
  AttachmentRepresentationKind,
} from "@openharness/protocol";
import type { StorageContext } from "../database/storage-context.js";
import {
  attachmentAssetFromRow,
  attachmentRepresentationFromRow,
  attachmentLeaseFromRow,
  type CreateImportingAttachmentInput,
  type CreateAttachmentRepresentationInput,
  type ImportingAttachmentRecord,
  type AttachmentLeaseRecord,
  type AcquireAttachmentLeasesInput,
  type MarkAttachmentReadyInput,
} from "./attachment-records.js";

export class AttachmentRepository {
  constructor(private readonly storage: StorageContext) {}

  private get database() {
    return this.storage.database.connection;
  }

  getAttachment(
    id: string,
    options: { includeDeleted?: boolean } = {},
  ): AttachmentAssetRecord | undefined {
    const row = this.database
      .prepare(
        `SELECT * FROM attachment_asset WHERE id = ?${options.includeDeleted ? "" : " AND status != 'deleted'"}`,
      )
      .get(id) as Record<string, unknown> | undefined;
    return row ? attachmentAssetFromRow(row) : undefined;
  }

  findReadyAttachmentByHash(sha256: string): AttachmentAssetRecord | undefined {
    const row = this.database
      .prepare(
        `SELECT * FROM attachment_asset
         WHERE sha256 = ? AND status = 'ready'
         ORDER BY created_at, id LIMIT 1`,
      )
      .get(sha256) as Record<string, unknown> | undefined;
    return row ? attachmentAssetFromRow(row) : undefined;
  }

  listAttachments(
    options: { includeDeleted?: boolean } = {},
  ): AttachmentAssetRecord[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM attachment_asset${options.includeDeleted ? "" : " WHERE status != 'deleted'"} ORDER BY created_at, id`,
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map(attachmentAssetFromRow);
  }

  listImportingAttachments(): ImportingAttachmentRecord[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM attachment_asset
         WHERE status = 'importing'
         ORDER BY created_at, id`,
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      ...attachmentAssetFromRow(row),
      stagingName: String(row.staging_name),
    }));
  }

  getAttachmentRepresentation(
    id: string,
  ): AttachmentRepresentationRecord | undefined {
    const row = this.database
      .prepare("SELECT * FROM attachment_representation WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row ? attachmentRepresentationFromRow(row) : undefined;
  }

  listAttachmentRepresentations(
    assetId: string,
  ): AttachmentRepresentationRecord[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM attachment_representation
       WHERE asset_id = ?
       ORDER BY created_at, id`,
      )
      .all(assetId) as Array<Record<string, unknown>>;
    return rows.map(attachmentRepresentationFromRow);
  }

  listActiveAttachmentLeases(timestamp = Date.now()): AttachmentLeaseRecord[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM attachment_lease
       WHERE expires_at > ?
       ORDER BY asset_id, owner_kind, owner_id`,
      )
      .all(timestamp) as Array<Record<string, unknown>>;
    return rows.map(attachmentLeaseFromRow);
  }

  listAttachmentLeases(): AttachmentLeaseRecord[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM attachment_lease
       ORDER BY asset_id, owner_kind, owner_id`,
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map(attachmentLeaseFromRow);
  }

  findCompletedAttachmentRepresentation(
    assetId: string,
    kind: AttachmentRepresentationKind,
    cacheKey: string,
  ): AttachmentRepresentationRecord | undefined {
    const row = this.database
      .prepare(
        `SELECT * FROM attachment_representation
       WHERE asset_id = ? AND kind = ? AND cache_key = ? AND status = 'completed'
       LIMIT 1`,
      )
      .get(assetId, kind, cacheKey) as Record<string, unknown> | undefined;
    return row ? attachmentRepresentationFromRow(row) : undefined;
  }

  createImportingAttachment(
    input: CreateImportingAttachmentInput,
  ): AttachmentAssetRecord {
    const timestamp = input.createdAt ?? Date.now();
    this.database
      .prepare(
        `INSERT INTO attachment_asset (
          id, display_name, declared_media_type, status, staging_name,
          created_at, updated_at
        ) VALUES (?, ?, ?, 'importing', ?, ?, ?)`,
      )
      .run(
        input.id,
        input.displayName,
        input.declaredMediaType ?? null,
        input.stagingName,
        timestamp,
        timestamp,
      );
    return this.getAttachment(input.id, { includeDeleted: true })!;
  }

  createAttachmentRepresentation(
    input: CreateAttachmentRepresentationInput,
  ): AttachmentRepresentationRecord {
    const createdAt = input.createdAt ?? Date.now();
    this.database
      .prepare(
        `INSERT INTO attachment_representation (
        id, asset_id, kind, status, processor, processor_version, cache_key,
        media_type, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, 'running', ?, ?, ?, ?, '{}', ?, ?)`,
      )
      .run(
        input.id,
        input.assetId,
        input.kind,
        input.processor,
        input.processorVersion,
        input.cacheKey,
        input.mediaType,
        createdAt,
        createdAt,
      );
    return this.getAttachmentRepresentation(input.id)!;
  }

  renewAttachmentLeases(input: {
    ownerKind: AttachmentLeaseRecord["ownerKind"];
    ownerId: string;
    timestamp: number;
    expiresAt: number;
  }): number {
    return this.database
      .prepare(
        `UPDATE attachment_lease
       SET renewed_at = ?, expires_at = ?
       WHERE owner_kind = ? AND owner_id = ? AND expires_at > ?`,
      )
      .run(
        input.timestamp,
        input.expiresAt,
        input.ownerKind,
        input.ownerId,
        input.timestamp,
      ).changes;
  }

  releaseAttachmentLeases(
    ownerKind: AttachmentLeaseRecord["ownerKind"],
    ownerId: string,
  ): number {
    return this.database
      .prepare(
        "DELETE FROM attachment_lease WHERE owner_kind = ? AND owner_id = ?",
      )
      .run(ownerKind, ownerId).changes;
  }

  deleteExpiredAttachmentLeases(timestamp = Date.now()): number {
    return this.database
      .prepare("DELETE FROM attachment_lease WHERE expires_at <= ?")
      .run(timestamp).changes;
  }

  markReady(
    id: string,
    input: MarkAttachmentReadyInput,
    updatedAt: number,
  ): boolean {
    return (
      this.database
        .prepare(
          `UPDATE attachment_asset
      SET sha256 = ?, size_bytes = ?, media_type = ?, status = 'ready',
          staging_name = NULL, failure_code = NULL, updated_at = ?
      WHERE id = ? AND status = 'importing'`,
        )
        .run(input.sha256, input.sizeBytes, input.mediaType, updatedAt, id)
        .changes === 1
    );
  }

  failImport(id: string, failureCode: string, updatedAt: number): boolean {
    return (
      this.database
        .prepare(
          `UPDATE attachment_asset
      SET status = 'failed', staging_name = NULL, failure_code = ?, updated_at = ?
      WHERE id = ? AND status = 'importing'`,
        )
        .run(failureCode, updatedAt, id).changes === 1
    );
  }

  softDelete(id: string, deletedAt: number): boolean {
    return (
      this.database
        .prepare(
          `UPDATE attachment_asset
      SET status = 'deleted', deleted_at = ?, updated_at = ?
      WHERE id = ? AND status = 'ready'`,
        )
        .run(deletedAt, deletedAt, id).changes === 1
    );
  }

  completeRepresentation(
    id: string,
    input: { text: string; metadata: Record<string, unknown> },
    updatedAt: number,
  ): boolean {
    return (
      this.database
        .prepare(
          `UPDATE attachment_representation
      SET status = 'completed', text = ?, error = NULL, metadata_json = ?, updated_at = ?
      WHERE id = ? AND status = 'running'`,
        )
        .run(input.text, JSON.stringify(input.metadata ?? {}), updatedAt, id)
        .changes === 1
    );
  }

  failRepresentation(id: string, error: string, updatedAt: number): boolean {
    return (
      this.database
        .prepare(
          `UPDATE attachment_representation
      SET status = 'failed', error = ?, updated_at = ?
      WHERE id = ? AND status = 'running'`,
        )
        .run(error, updatedAt, id).changes === 1
    );
  }

  upsertLease(
    assetId: string,
    input: AcquireAttachmentLeasesInput,
  ): AttachmentLeaseRecord {
    this.database
      .prepare(
        `INSERT INTO attachment_lease (
      id, asset_id, owner_kind, owner_id, created_at, renewed_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(asset_id, owner_kind, owner_id) DO UPDATE SET
      renewed_at = excluded.renewed_at, expires_at = excluded.expires_at`,
      )
      .run(
        randomUUID(),
        assetId,
        input.ownerKind,
        input.ownerId,
        input.timestamp,
        input.timestamp,
        input.expiresAt,
      );
    const row = this.database
      .prepare(
        `SELECT * FROM attachment_lease
      WHERE asset_id = ? AND owner_kind = ? AND owner_id = ?`,
      )
      .get(assetId, input.ownerKind, input.ownerId) as Record<string, unknown>;
    return attachmentLeaseFromRow(row);
  }

  hasActiveLease(assetId: string, timestamp: number): boolean {
    return !!this.database
      .prepare(
        `SELECT 1 FROM attachment_lease
      WHERE asset_id = ? AND expires_at > ? LIMIT 1`,
      )
      .get(assetId, timestamp);
  }

  purgeDeleted(assetId: string): boolean {
    return (
      this.database
        .prepare(
          "DELETE FROM attachment_asset WHERE id = ? AND status = 'deleted'",
        )
        .run(assetId).changes === 1
    );
  }
}

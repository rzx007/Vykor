import { randomUUID } from "node:crypto";
import type {
  AttachmentAssetRecord,
  AttachmentRepresentationRecord,
  AttachmentRepresentationKind,
  ChatResourceSource,
} from "@vykor/protocol";
import { and, eq, gt, lte, ne } from "drizzle-orm";
import type { StorageContext } from "../../database/storage-context.js";
import {
  attachmentAssets,
  attachmentLeases,
  attachmentRepresentations,
} from "../../session-runtime/schema.js";
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
    return this.storage.database.orm;
  }

  recordChatSource(assetId: string, source: ChatResourceSource): void {
    const asset = this.getAttachment(assetId, { includeDeleted: true });
    if (!asset) throw new Error(`Attachment ${assetId} was not found`);
    const sources = asset.chatSources ?? [];
    if (sources.some((current) => current.storage === source.storage && current.sessionId === source.sessionId)) return;
    this.database.update(attachmentAssets)
      .set({ chatSourcesJson: JSON.stringify([...sources, source]) })
      .where(eq(attachmentAssets.id, assetId)).run();
  }

  hasPersistentChatSource(assetId: string): boolean {
    return this.getAttachment(assetId, { includeDeleted: true })?.chatSources?.some((source) => source.storage === "memory") ?? false;
  }

  getAttachment(
    id: string,
    options: { includeDeleted?: boolean } = {},
  ): AttachmentAssetRecord | undefined {
    const row = this.database
      .select()
      .from(attachmentAssets)
      .where(
        and(
          eq(attachmentAssets.id, id),
          options.includeDeleted
            ? undefined
            : ne(attachmentAssets.status, "deleted"),
        ),
      )
      .get();
    return row ? attachmentAssetFromRow(row) : undefined;
  }

  findReadyAttachmentByHash(sha256: string): AttachmentAssetRecord | undefined {
    const row = this.database
      .select()
      .from(attachmentAssets)
      .where(
        and(
          eq(attachmentAssets.sha256, sha256),
          eq(attachmentAssets.status, "ready"),
        ),
      )
      .orderBy(attachmentAssets.createdAt, attachmentAssets.id)
      .limit(1)
      .get();
    return row ? attachmentAssetFromRow(row) : undefined;
  }

  listAttachments(
    options: { includeDeleted?: boolean } = {},
  ): AttachmentAssetRecord[] {
    const rows = this.database
      .select()
      .from(attachmentAssets)
      .where(
        options.includeDeleted
          ? undefined
          : ne(attachmentAssets.status, "deleted"),
      )
      .orderBy(attachmentAssets.createdAt, attachmentAssets.id)
      .all();
    return rows.map(attachmentAssetFromRow);
  }

  listImportingAttachments(): ImportingAttachmentRecord[] {
    const rows = this.database
      .select()
      .from(attachmentAssets)
      .where(eq(attachmentAssets.status, "importing"))
      .orderBy(attachmentAssets.createdAt, attachmentAssets.id)
      .all();
    return rows.map((row) => ({
      ...attachmentAssetFromRow(row),
      stagingName: String(row.stagingName),
    }));
  }

  getAttachmentRepresentation(
    id: string,
  ): AttachmentRepresentationRecord | undefined {
    const row = this.database
      .select()
      .from(attachmentRepresentations)
      .where(eq(attachmentRepresentations.id, id))
      .get();
    return row ? attachmentRepresentationFromRow(row) : undefined;
  }

  listAttachmentRepresentations(
    assetId: string,
  ): AttachmentRepresentationRecord[] {
    const rows = this.database
      .select()
      .from(attachmentRepresentations)
      .where(eq(attachmentRepresentations.assetId, assetId))
      .orderBy(attachmentRepresentations.createdAt, attachmentRepresentations.id)
      .all();
    return rows.map(attachmentRepresentationFromRow);
  }

  listActiveAttachmentLeases(timestamp = Date.now()): AttachmentLeaseRecord[] {
    const rows = this.database
      .select()
      .from(attachmentLeases)
      .where(gt(attachmentLeases.expiresAt, timestamp))
      .orderBy(
        attachmentLeases.assetId,
        attachmentLeases.ownerKind,
        attachmentLeases.ownerId,
      )
      .all();
    return rows.map(attachmentLeaseFromRow);
  }

  listAttachmentLeases(): AttachmentLeaseRecord[] {
    const rows = this.database
      .select()
      .from(attachmentLeases)
      .orderBy(
        attachmentLeases.assetId,
        attachmentLeases.ownerKind,
        attachmentLeases.ownerId,
      )
      .all();
    return rows.map(attachmentLeaseFromRow);
  }

  findCompletedAttachmentRepresentation(
    assetId: string,
    kind: AttachmentRepresentationKind,
    cacheKey: string,
  ): AttachmentRepresentationRecord | undefined {
    const row = this.database
      .select()
      .from(attachmentRepresentations)
      .where(
        and(
          eq(attachmentRepresentations.assetId, assetId),
          eq(attachmentRepresentations.kind, kind),
          eq(attachmentRepresentations.cacheKey, cacheKey),
          eq(attachmentRepresentations.status, "completed"),
        ),
      )
      .limit(1)
      .get();
    return row ? attachmentRepresentationFromRow(row) : undefined;
  }

  createImportingAttachment(
    input: CreateImportingAttachmentInput,
  ): AttachmentAssetRecord {
    const timestamp = input.createdAt ?? Date.now();
    this.database
      .insert(attachmentAssets)
      .values({
        id: input.id,
        displayName: input.displayName,
        declaredMediaType: input.declaredMediaType ?? null,
        status: "importing",
        stagingName: input.stagingName,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .run();
    return this.getAttachment(input.id, { includeDeleted: true })!;
  }

  createAttachmentRepresentation(
    input: CreateAttachmentRepresentationInput,
  ): AttachmentRepresentationRecord {
    const createdAt = input.createdAt ?? Date.now();
    this.database
      .insert(attachmentRepresentations)
      .values({
        id: input.id,
        assetId: input.assetId,
        kind: input.kind,
        status: "running",
        processor: input.processor,
        processorVersion: input.processorVersion,
        cacheKey: input.cacheKey,
        mediaType: input.mediaType,
        metadataJson: "{}",
        createdAt,
        updatedAt: createdAt,
      })
      .run();
    return this.getAttachmentRepresentation(input.id)!;
  }

  renewAttachmentLeases(input: {
    ownerKind: AttachmentLeaseRecord["ownerKind"];
    ownerId: string;
    timestamp: number;
    expiresAt: number;
  }): number {
    return this.database
      .update(attachmentLeases)
      .set({ renewedAt: input.timestamp, expiresAt: input.expiresAt })
      .where(
        and(
          eq(attachmentLeases.ownerKind, input.ownerKind),
          eq(attachmentLeases.ownerId, input.ownerId),
          gt(attachmentLeases.expiresAt, input.timestamp),
        ),
      )
      .run().changes;
  }

  releaseAttachmentLeases(
    ownerKind: AttachmentLeaseRecord["ownerKind"],
    ownerId: string,
  ): number {
    return this.database
      .delete(attachmentLeases)
      .where(
        and(
          eq(attachmentLeases.ownerKind, ownerKind),
          eq(attachmentLeases.ownerId, ownerId),
        ),
      )
      .run().changes;
  }

  deleteExpiredAttachmentLeases(timestamp = Date.now()): number {
    return this.database
      .delete(attachmentLeases)
      .where(lte(attachmentLeases.expiresAt, timestamp))
      .run().changes;
  }

  markReady(
    id: string,
    input: MarkAttachmentReadyInput,
    updatedAt: number,
  ): boolean {
    return (
      this.database
        .update(attachmentAssets)
        .set({
          sha256: input.sha256,
          sizeBytes: input.sizeBytes,
          mediaType: input.mediaType,
          status: "ready",
          stagingName: null,
          failureCode: null,
          updatedAt,
        })
        .where(
          and(eq(attachmentAssets.id, id), eq(attachmentAssets.status, "importing")),
        )
        .run()
        .changes === 1
    );
  }

  failImport(id: string, failureCode: string, updatedAt: number): boolean {
    return (
      this.database
        .update(attachmentAssets)
        .set({ status: "failed", stagingName: null, failureCode, updatedAt })
        .where(
          and(eq(attachmentAssets.id, id), eq(attachmentAssets.status, "importing")),
        )
        .run().changes === 1
    );
  }

  softDelete(id: string, deletedAt: number): boolean {
    return (
      this.database
        .update(attachmentAssets)
        .set({ status: "deleted", deletedAt, updatedAt: deletedAt })
        .where(
          and(eq(attachmentAssets.id, id), eq(attachmentAssets.status, "ready")),
        )
        .run().changes === 1
    );
  }

  completeRepresentation(
    id: string,
    input: { text: string; metadata: Record<string, unknown> },
    updatedAt: number,
  ): boolean {
    return (
      this.database
        .update(attachmentRepresentations)
        .set({
          status: "completed",
          text: input.text,
          error: null,
          metadataJson: JSON.stringify(input.metadata ?? {}),
          updatedAt,
        })
        .where(
          and(
            eq(attachmentRepresentations.id, id),
            eq(attachmentRepresentations.status, "running"),
          ),
        )
        .run()
        .changes === 1
    );
  }

  failRepresentation(id: string, error: string, updatedAt: number): boolean {
    return (
      this.database
        .update(attachmentRepresentations)
        .set({ status: "failed", error, updatedAt })
        .where(
          and(
            eq(attachmentRepresentations.id, id),
            eq(attachmentRepresentations.status, "running"),
          ),
        )
        .run().changes === 1
    );
  }

  upsertLease(
    assetId: string,
    input: AcquireAttachmentLeasesInput,
  ): AttachmentLeaseRecord {
    this.database
      .insert(attachmentLeases)
      .values({
        id: randomUUID(),
        assetId,
        ownerKind: input.ownerKind,
        ownerId: input.ownerId,
        createdAt: input.timestamp,
        renewedAt: input.timestamp,
        expiresAt: input.expiresAt,
      })
      .onConflictDoUpdate({
        target: [
          attachmentLeases.assetId,
          attachmentLeases.ownerKind,
          attachmentLeases.ownerId,
        ],
        set: { renewedAt: input.timestamp, expiresAt: input.expiresAt },
      })
      .run();
    const row = this.database
      .select()
      .from(attachmentLeases)
      .where(
        and(
          eq(attachmentLeases.assetId, assetId),
          eq(attachmentLeases.ownerKind, input.ownerKind),
          eq(attachmentLeases.ownerId, input.ownerId),
        ),
      )
      .get()!;
    return attachmentLeaseFromRow(row);
  }

  hasActiveLease(assetId: string, timestamp: number): boolean {
    return !!this.database
      .select({ id: attachmentLeases.id })
      .from(attachmentLeases)
      .where(
        and(
          eq(attachmentLeases.assetId, assetId),
          gt(attachmentLeases.expiresAt, timestamp),
        ),
      )
      .limit(1)
      .get();
  }

  purgeDeleted(assetId: string): boolean {
    return (
      this.database
        .delete(attachmentAssets)
        .where(
          and(
            eq(attachmentAssets.id, assetId),
            eq(attachmentAssets.status, "deleted"),
          ),
        )
        .run().changes === 1
    );
  }
}

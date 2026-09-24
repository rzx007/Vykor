import { parseAttachmentAssetRecord } from "@vykor/protocol";
import type {
  AttachmentAssetRecord,
  AttachmentRepresentationRecord,
  AttachmentRepresentationKind,
} from "@vykor/protocol";
import { AttachmentError } from "../attachment-errors.js";
import type { StorageContext } from "../../database/storage-context.js";
import type {
  CreateImportingAttachmentInput,
  CreateAttachmentRepresentationInput,
  ImportingAttachmentRecord,
  AttachmentLeaseRecord,
  AcquireAttachmentLeasesInput,
  MarkAttachmentReadyInput,
} from "./attachment-records.js";
import { AttachmentRepository } from "./attachment-repository.js";

export interface AttachmentTransactionsOptions {
  storage: StorageContext;
  repository: AttachmentRepository;
  countAttachmentReferences(assetId: string): number;
  countInputAttachmentReferences(assetId: string): number;
}

export class AttachmentTransactions {
  constructor(private readonly options: AttachmentTransactionsOptions) {}

  countAttachmentReferences(assetId: string): number {
    return this.options.countAttachmentReferences(assetId);
  }

  countInputAttachmentReferences(assetId: string): number {
    return this.options.countInputAttachmentReferences(assetId);
  }

  getAttachment(
    id: string,
    options: { includeDeleted?: boolean } = {},
  ): AttachmentAssetRecord | undefined {
    return this.options.repository.getAttachment(id, options);
  }

  findReadyAttachmentByHash(sha256: string): AttachmentAssetRecord | undefined {
    return this.options.repository.findReadyAttachmentByHash(sha256);
  }

  listAttachments(
    options: { includeDeleted?: boolean } = {},
  ): AttachmentAssetRecord[] {
    return this.options.repository.listAttachments(options);
  }

  listImportingAttachments(): ImportingAttachmentRecord[] {
    return this.options.repository.listImportingAttachments();
  }

  getAttachmentRepresentation(
    id: string,
  ): AttachmentRepresentationRecord | undefined {
    return this.options.repository.getAttachmentRepresentation(id);
  }

  listAttachmentRepresentations(
    assetId: string,
  ): AttachmentRepresentationRecord[] {
    return this.options.repository.listAttachmentRepresentations(assetId);
  }

  listActiveAttachmentLeases(timestamp = Date.now()): AttachmentLeaseRecord[] {
    return this.options.repository.listActiveAttachmentLeases(timestamp);
  }

  listAttachmentLeases(): AttachmentLeaseRecord[] {
    return this.options.repository.listAttachmentLeases();
  }

  findCompletedAttachmentRepresentation(
    assetId: string,
    kind: AttachmentRepresentationKind,
    cacheKey: string,
  ): AttachmentRepresentationRecord | undefined {
    return this.options.repository.findCompletedAttachmentRepresentation(
      assetId,
      kind,
      cacheKey,
    );
  }

  createImportingAttachment(
    input: CreateImportingAttachmentInput,
  ): AttachmentAssetRecord {
    return this.write(() => {
      const timestamp = input.createdAt ?? Date.now();
      parseAttachmentAssetRecord({
        id: input.id,
        displayName: input.displayName,
        ...(input.declaredMediaType
          ? { declaredMediaType: input.declaredMediaType }
          : {}),
        status: "importing",
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      return this.options.repository.createImportingAttachment({
        ...input,
        createdAt: timestamp,
      });
    });
  }

  markAttachmentReady(
    id: string,
    input: MarkAttachmentReadyInput,
  ): AttachmentAssetRecord {
    return this.write(() => {
      const current = this.attachmentForTransition(id, "importing");
      const updatedAt = input.updatedAt ?? Date.now();
      parseAttachmentAssetRecord({
        ...current,
        sha256: input.sha256,
        sizeBytes: input.sizeBytes,
        mediaType: input.mediaType,
        status: "ready",
        updatedAt,
      });
      const changed = this.options.repository.markReady(id, input, updatedAt);
      if (!changed) {
        throw this.attachmentTransitionError(id, "importing");
      }
      return this.getAttachment(id, { includeDeleted: true })!;
    });
  }

  failAttachmentImport(
    id: string,
    failureCode: string,
    updatedAt = Date.now(),
  ): AttachmentAssetRecord {
    return this.write(() => {
      const current = this.attachmentForTransition(id, "importing");
      parseAttachmentAssetRecord({
        ...current,
        status: "failed",
        failureCode,
        updatedAt,
      });
      const changed = this.options.repository.failImport(
        id,
        failureCode,
        updatedAt,
      );
      if (!changed) {
        throw this.attachmentTransitionError(id, "importing");
      }
      return this.getAttachment(id, { includeDeleted: true })!;
    });
  }

  softDeleteAttachment(
    id: string,
    deletedAt = Date.now(),
  ): AttachmentAssetRecord {
    return this.write(() => {
      const current = this.attachmentForTransition(id, "ready");
      parseAttachmentAssetRecord({
        ...current,
        status: "deleted",
        deletedAt,
        updatedAt: deletedAt,
      });
      const changed = this.options.repository.softDelete(id, deletedAt);
      if (!changed) {
        throw this.attachmentTransitionError(id, "ready");
      }
      return this.getAttachment(id, { includeDeleted: true })!;
    });
  }

  createAttachmentRepresentation(
    input: CreateAttachmentRepresentationInput,
  ): AttachmentRepresentationRecord {
    return this.write(() =>
      this.options.repository.createAttachmentRepresentation(input),
    );
  }

  releaseAttachmentLeases(
    ownerKind: AttachmentLeaseRecord["ownerKind"],
    ownerId: string,
  ): number {
    return this.write(() =>
      this.options.repository.releaseAttachmentLeases(ownerKind, ownerId),
    );
  }

  deleteExpiredAttachmentLeases(timestamp = Date.now()): number {
    return this.write(() =>
      this.options.repository.deleteExpiredAttachmentLeases(timestamp),
    );
  }

  renewAttachmentLeases(input: {
    ownerKind: AttachmentLeaseRecord["ownerKind"];
    ownerId: string;
    timestamp: number;
    expiresAt: number;
  }): number {
    return this.write(() => {
      validateLeaseWindow(input.timestamp, input.expiresAt);
      return this.options.repository.renewAttachmentLeases(input);
    });
  }

  acquireAttachmentLeases(
    input: AcquireAttachmentLeasesInput,
  ): AttachmentLeaseRecord[] {
    return this.write(() => {
      validateLeaseWindow(input.timestamp, input.expiresAt);
      const assetIds = [...new Set(input.assetIds)];
      for (const assetId of assetIds) {
        if (this.getAttachment(assetId)?.status !== "ready") {
          throw new AttachmentError(
            "attachment_not_ready",
            `Attachment is not ready: ${assetId}`,
          );
        }
      }
      return assetIds.map((assetId) =>
        this.options.repository.upsertLease(assetId, input),
      );
    });
  }

  completeAttachmentRepresentation(
    id: string,
    input: {
      text: string;
      metadata: Record<string, unknown>;
      updatedAt?: number;
    },
  ): AttachmentRepresentationRecord {
    return this.write(() => {
      if (
        !this.options.repository.completeRepresentation(
          id,
          input,
          input.updatedAt ?? Date.now(),
        )
      ) {
        throw new Error(`Attachment representation ${id} is not running`);
      }
      return this.getAttachmentRepresentation(id)!;
    });
  }

  failAttachmentRepresentation(
    id: string,
    error: string,
    updatedAt = Date.now(),
  ): AttachmentRepresentationRecord {
    return this.write(() => {
      if (!this.options.repository.failRepresentation(id, error, updatedAt)) {
        throw new Error(`Attachment representation ${id} is not running`);
      }
      return this.getAttachmentRepresentation(id)!;
    });
  }

  softDeleteUnreferencedAttachment(
    id: string,
    deletedAt = Date.now(),
  ): AttachmentAssetRecord {
    return this.write(() => {
      if (this.countAttachmentReferences(id) > 0) {
        throw new AttachmentError(
          "attachment_in_use",
          "attachment is referenced by a conversation",
        );
      }
      return this.softDeleteAttachment(id, deletedAt);
    });
  }

  purgeDeletedAttachment(
    assetId: string,
    timestamp = Date.now(),
  ): AttachmentAssetRecord | undefined {
    return this.write(() => {
      const asset = this.getAttachment(assetId, { includeDeleted: true });
      if (asset?.status !== "deleted") return undefined;
      if (this.countAttachmentReferences(assetId) > 0) return undefined;
      if (this.options.repository.hasActiveLease(assetId, timestamp))
        return undefined;
      return this.options.repository.purgeDeleted(assetId) ? asset : undefined;
    });
  }

  private attachmentTransitionError(id: string, expected: string): Error {
    const current = this.getAttachment(id, { includeDeleted: true });
    return current
      ? new Error(
          `Attachment ${id} expected ${expected} status, received ${current.status}`,
        )
      : new Error(
          `Attachment ${id} was not found; expected ${expected} status`,
        );
  }

  private attachmentForTransition(
    id: string,
    expected: AttachmentAssetRecord["status"],
  ): AttachmentAssetRecord {
    const current = this.getAttachment(id, { includeDeleted: true });
    if (!current || current.status !== expected) {
      throw this.attachmentTransitionError(id, expected);
    }
    return current;
  }

  private write<T>(work: () => T): T {
    return this.options.storage.atomic(() => {
      this.options.storage.assertWritable();
      return work();
    });
  }
}

function validateLeaseWindow(timestamp: number, expiresAt: number): void {
  if (
    !Number.isSafeInteger(timestamp) ||
    timestamp < 0 ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= timestamp
  ) {
    throw new Error("Attachment lease expiry must be after its timestamp");
  }
}

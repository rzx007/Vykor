import { randomUUID } from "node:crypto";

import {
  DEFAULT_ATTACHMENT_LIMITS,
  parseAttachmentLimits,
  type AttachmentAssetRecord,
  type AttachmentLimits,
} from "@vykor/protocol";
import {
  AttachmentBlobStore,
  AttachmentError,
  AttachmentStorageOperationGate,
  decodeAttachmentText,
  isAttachmentError,
  type AttachmentBlobRange,
  type AttachmentTextEncoding,
  type AttachmentTransactions,
} from "@vykor/services";

export interface AttachmentServiceOptions {
  store: Pick<AttachmentTransactions,
    | "createImportingAttachment"
    | "markAttachmentReady"
    | "failAttachmentImport"
    | "getAttachment"
    | "softDeleteUnreferencedAttachment"
    | "listImportingAttachments"
  >;
  blobs: AttachmentBlobStore;
  limits?: Partial<AttachmentLimits>;
  now?: () => number;
  id?: () => string;
  operationGate?: AttachmentStorageOperationGate;
}

export interface ImportAttachmentInput {
  displayName: string;
  declaredMediaType?: string;
  content: ReadableStream<Uint8Array>;
  signal?: AbortSignal;
}

export interface OpenAttachmentContentResult {
  asset: AttachmentAssetRecord;
  sha256: string;
  sizeBytes: number;
  mediaType: string;
  content: ReadableStream<Uint8Array>;
}

export interface ResolvedAttachmentContentPath {
  assetId: string;
  path: string;
  mediaType: string;
  sizeBytes: number;
}

export interface ReadyAttachmentTextResult {
  assetId: string;
  displayName: string;
  mediaType: string;
  encoding: AttachmentTextEncoding;
  text: string;
}

export interface AttachmentRecoveryResult {
  failedImportIds: string[];
  removedStagingNames: string[];
  retainedStagingNames: string[];
}

export class AttachmentService {
  readonly limits: AttachmentLimits;
  readonly operationGate: AttachmentStorageOperationGate;
  private readonly store: AttachmentServiceOptions["store"];
  private readonly blobs: AttachmentBlobStore;
  private readonly now: () => number;
  private readonly id: () => string;

  constructor(options: AttachmentServiceOptions) {
    this.store = options.store;
    this.blobs = options.blobs;
    this.now = options.now ?? Date.now;
    this.id = options.id ?? (() => `att_${randomUUID()}`);
    this.operationGate = options.operationGate ?? new AttachmentStorageOperationGate();
    this.limits = parseAttachmentLimits({
      ...DEFAULT_ATTACHMENT_LIMITS,
      ...options.limits,
    });
  }

  async import(input: ImportAttachmentInput): Promise<AttachmentAssetRecord> {
    return await this.operationGate.runShared(() => this.importUnlocked(input));
  }

  private async importUnlocked(input: ImportAttachmentInput): Promise<AttachmentAssetRecord> {
    const id = this.id();
    this.store.createImportingAttachment({
      id,
      displayName: input.displayName,
      ...(input.declaredMediaType
        ? { declaredMediaType: input.declaredMediaType }
        : {}),
      stagingName: `${id}.part`,
      createdAt: this.now(),
    });
    try {
      const imported = await this.blobs.import({
        uploadId: id,
        content: input.content,
        ...(input.declaredMediaType
          ? { declaredMediaType: input.declaredMediaType }
          : {}),
        maxBytes: this.limits.maxBytesPerFile,
        signal: input.signal,
      });
      return this.store.markAttachmentReady(id, {
        sha256: imported.sha256,
        sizeBytes: imported.sizeBytes,
        mediaType: imported.mediaType,
        updatedAt: this.now(),
      });
    } catch (error) {
      const normalized = normalizeAttachmentFailure(error);
      try {
        this.store.failAttachmentImport(id, normalized.code, this.now());
      } catch {
        // Preserve the original import failure. Recovery will reconcile any
        // importing record left behind by a concurrent database failure.
      }
      throw normalized;
    }
  }

  get(id: string): AttachmentAssetRecord {
    const asset = this.store.getAttachment(id);
    if (!asset) throw attachmentNotFound();
    return asset;
  }

  async openContent(
    id: string,
    range: AttachmentBlobRange = {},
  ): Promise<OpenAttachmentContentResult> {
    const asset = this.get(id);
    if (
      asset.status !== "ready" ||
      !asset.sha256 ||
      asset.sizeBytes === undefined ||
      !asset.mediaType
    ) {
      throw new AttachmentError(
        "attachment_not_ready",
        "attachment content is not ready",
      );
    }
    return {
      asset,
      sha256: asset.sha256,
      sizeBytes: asset.sizeBytes,
      mediaType: asset.mediaType,
      content: await this.blobs.open(asset.sha256, asset.sizeBytes, range),
    };
  }

  async resolveReadyContentPath(
    id: string,
  ): Promise<ResolvedAttachmentContentPath> {
    const asset = this.get(id);
    if (
      asset.status !== "ready" ||
      !asset.sha256 ||
      asset.sizeBytes === undefined ||
      !asset.mediaType
    ) {
      throw new AttachmentError(
        "attachment_not_ready",
        "attachment content is not ready",
      );
    }
    return {
      assetId: asset.id,
      path: await this.blobs.resolveReadOnlyPath(asset.sha256, asset.sizeBytes),
      mediaType: asset.mediaType,
      sizeBytes: asset.sizeBytes,
    };
  }

  async readReadyText(
    id: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<ReadyAttachmentTextResult> {
    const opened = await this.openContent(id);
    const bytes = await readAllBytes(opened.content, options.signal);
    const decoded = decodeAttachmentText(bytes);
    return {
      assetId: opened.asset.id,
      displayName: opened.asset.displayName,
      mediaType: opened.mediaType,
      encoding: decoded.encoding,
      text: decoded.text,
    };
  }

  delete(id: string): AttachmentAssetRecord {
    const asset = this.get(id);
    if (asset.status !== "ready") {
      throw new AttachmentError(
        "attachment_not_ready",
        "only ready attachments can be deleted",
      );
    }
    return this.store.softDeleteUnreferencedAttachment(id, this.now());
  }

  async recover(): Promise<AttachmentRecoveryResult> {
    const importing = this.store.listImportingAttachments();
    const staging = await this.blobs.recoverStaging({
      activeNames: new Set(),
      olderThan: this.blobs.stagingCutoff(this.limits.stagingTtlMs),
    });
    const recoverableStagingNames = new Set(staging.recoverable);
    const failedImportIds: string[] = [];
    for (const asset of importing) {
      this.store.failAttachmentImport(
        asset.id,
        recoverableStagingNames.has(asset.stagingName)
          ? "attachment_aborted"
          : "attachment_storage_failed",
        this.now(),
      );
      failedImportIds.push(asset.id);
    }
    return {
      failedImportIds,
      removedStagingNames: staging.removed,
      retainedStagingNames: staging.retained,
    };
  }
}

function normalizeAttachmentFailure(error: unknown): AttachmentError {
  if (isAttachmentError(error)) return error;
  return new AttachmentError(
    "attachment_storage_failed",
    "attachment import failed",
    true,
  );
}

function attachmentNotFound(): AttachmentError {
  return new AttachmentError("attachment_not_found", "attachment not found");
}

async function readAllBytes(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      if (signal?.aborted) {
        throw new AttachmentError("attachment_aborted", "attachment read aborted");
      }
      const result = await reader.read();
      if (result.done) break;
      chunks.push(result.value);
      length += result.value.byteLength;
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

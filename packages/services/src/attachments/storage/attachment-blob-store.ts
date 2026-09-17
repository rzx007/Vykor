import { createHash } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  rmdir,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";

import { AttachmentError, isAttachmentError } from "../attachment-errors.js";
import { sniffAttachmentMediaType } from "./attachment-media-type.js";

const MIME_PREFIX_BYTES = 4_100;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const UPLOAD_ID_PATTERN = /^[a-zA-Z0-9._-]+$/;

export interface AttachmentBlobStoreOptions {
  root: string;
  now?: () => number;
}

export interface ImportAttachmentBlobInput {
  uploadId: string;
  content: ReadableStream<Uint8Array>;
  declaredMediaType?: string;
  maxBytes: number;
  signal?: AbortSignal;
}

export interface ImportedAttachmentBlob {
  sha256: string;
  sizeBytes: number;
  mediaType: string;
  deduplicated: boolean;
}

export interface AttachmentBlobRange {
  start?: number;
  end?: number;
}

export interface StoredAttachmentBlob {
  sha256: string;
  sizeBytes: number;
  modifiedAt: number;
}

export interface RecoverStagingOptions {
  activeNames: ReadonlySet<string>;
  olderThan: number;
}

export interface RecoverStagingResult {
  removed: string[];
  retained: string[];
  recoverable: string[];
}

export class AttachmentBlobStore {
  private readonly blobsRoot: string;
  private readonly stagingRoot: string;
  private readonly now: () => number;

  constructor(options: AttachmentBlobStoreOptions) {
    this.blobsRoot = join(options.root, "blobs");
    this.stagingRoot = join(options.root, "staging");
    this.now = options.now ?? Date.now;
  }

  async initialize(): Promise<void> {
    await Promise.all([
      mkdir(this.blobsRoot, { recursive: true }),
      mkdir(this.stagingRoot, { recursive: true }),
    ]);
  }

  async import(input: ImportAttachmentBlobInput): Promise<ImportedAttachmentBlob> {
    validateUploadId(input.uploadId);
    if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 0) {
      throw new AttachmentError(
        "attachment_invalid_request",
        "maxBytes must be a non-negative safe integer",
      );
    }
    await this.initialize();

    const stagingPath = join(this.stagingRoot, `${input.uploadId}.part`);
    const reader = input.content.getReader();
    let handle: FileHandle | undefined;
    let succeeded = false;
    try {
      throwIfAborted(input.signal);
      handle = await open(stagingPath, "wx");
      const hash = createHash("sha256");
      const prefix = new Uint8Array(MIME_PREFIX_BYTES);
      let prefixLength = 0;
      let sizeBytes = 0;

      while (true) {
        throwIfAborted(input.signal);
        const result = await readWithAbort(reader, input.signal);
        if (result.done) break;
        const chunk = result.value;
        if (sizeBytes + chunk.byteLength > input.maxBytes) {
          throw new AttachmentError(
            "attachment_too_large",
            `attachment exceeds the ${input.maxBytes} byte limit`,
          );
        }
        await writeAll(handle, chunk);
        hash.update(chunk);
        sizeBytes += chunk.byteLength;
        if (prefixLength < prefix.byteLength) {
          const length = Math.min(
            chunk.byteLength,
            prefix.byteLength - prefixLength,
          );
          prefix.set(chunk.subarray(0, length), prefixLength);
          prefixLength += length;
        }
      }

      await handle.sync();
      await handle.close();
      handle = undefined;

      const sha256 = hash.digest("hex");
      const mediaType = sniffAttachmentMediaType(
        prefix.subarray(0, prefixLength),
        input.declaredMediaType,
        sizeBytes === prefixLength,
      );
      const bucket = join(this.blobsRoot, sha256.slice(0, 2));
      const blobPath = join(bucket, sha256);
      await mkdir(bucket, { recursive: true });

      let deduplicated = false;
      try {
        await link(stagingPath, blobPath);
      } catch (error) {
        if (nodeErrorCode(error) !== "EEXIST") throw error;
        deduplicated = true;
      }
      await unlink(stagingPath);
      succeeded = true;
      return { sha256, sizeBytes, mediaType, deduplicated };
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      await handle?.close().catch(() => undefined);
      await unlink(stagingPath).catch(() => undefined);
      if (isAttachmentError(error)) throw error;
      throw new AttachmentError(
        "attachment_storage_failed",
        "failed to persist attachment bytes",
        true,
      );
    } finally {
      if (!succeeded) await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }

  async open(
    sha256: string,
    expectedSizeBytes: number,
    range: AttachmentBlobRange = {},
  ): Promise<ReadableStream<Uint8Array>> {
    validateSha256(sha256);
    const expectedSize = optionalNonNegativeSafeInteger(
      expectedSizeBytes,
      "expectedSizeBytes",
    )!;
    const start = optionalNonNegativeSafeInteger(range.start, "range.start");
    const end = optionalNonNegativeSafeInteger(range.end, "range.end");
    if (start !== undefined && end !== undefined && end < start) {
      throw new AttachmentError(
        "attachment_invalid_request",
        "range.end must not be less than range.start",
      );
    }
    let handle: FileHandle | undefined;
    try {
      handle = await open(
        join(this.blobsRoot, sha256.slice(0, 2), sha256),
        "r",
      );
      const stats = await handle.stat();
      if (!stats.isFile() || stats.size !== expectedSize) {
        throw attachmentBytesUnavailable();
      }
      const stream = handle.createReadStream({
        ...(start !== undefined ? { start } : {}),
        ...(end !== undefined ? { end } : {}),
        autoClose: true,
      });
      handle = undefined;
      return normalizeBlobReadErrors(
        Readable.toWeb(stream) as ReadableStream<Uint8Array>,
      );
    } catch (error) {
      await handle?.close().catch(() => undefined);
      if (isAttachmentError(error)) throw error;
      throw attachmentBytesUnavailable();
    }
  }

  async resolveReadOnlyPath(
    sha256: string,
    expectedSizeBytes: number,
  ): Promise<string> {
    validateSha256(sha256);
    const expectedSize = optionalNonNegativeSafeInteger(
      expectedSizeBytes,
      "expectedSizeBytes",
    )!;
    const blobPath = join(this.blobsRoot, sha256.slice(0, 2), sha256);
    try {
      const stats = await lstat(blobPath);
      if (!stats.isFile() || stats.isSymbolicLink() || stats.size !== expectedSize) {
        throw attachmentBytesUnavailable();
      }
      return blobPath;
    } catch (error) {
      if (isAttachmentError(error)) throw error;
      throw attachmentBytesUnavailable();
    }
  }

  async listBlobs(): Promise<StoredAttachmentBlob[]> {
    await this.initialize();
    const blobs: StoredAttachmentBlob[] = [];
    const buckets = await readdir(this.blobsRoot, { withFileTypes: true });
    for (const bucket of buckets) {
      if (!bucket.isDirectory() || !/^[a-f0-9]{2}$/.test(bucket.name)) continue;
      const bucketRoot = join(this.blobsRoot, bucket.name);
      const entries = await readdir(bucketRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (
          !entry.isFile() ||
          !SHA256_PATTERN.test(entry.name) ||
          !entry.name.startsWith(bucket.name)
        ) {
          continue;
        }
        const stats = await lstat(join(bucketRoot, entry.name));
        if (!stats.isFile() || stats.isSymbolicLink()) continue;
        blobs.push({
          sha256: entry.name,
          sizeBytes: stats.size,
          modifiedAt: stats.mtimeMs,
        });
      }
    }
    return blobs.sort((left, right) => left.sha256.localeCompare(right.sha256));
  }

  async inspectBlob(sha256: string): Promise<StoredAttachmentBlob | undefined> {
    validateSha256(sha256);
    try {
      const stats = await lstat(this.blobPath(sha256));
      if (!stats.isFile() || stats.isSymbolicLink()) {
        throw attachmentBytesUnavailable();
      }
      return { sha256, sizeBytes: stats.size, modifiedAt: stats.mtimeMs };
    } catch (error) {
      if (nodeErrorCode(error) === "ENOENT") return undefined;
      if (isAttachmentError(error)) throw error;
      throw attachmentBytesUnavailable();
    }
  }

  async deleteBlob(
    sha256: string,
  ): Promise<{ deleted: boolean; sizeBytes: number }> {
    validateSha256(sha256);
    const blob = await this.inspectBlob(sha256);
    if (!blob) return { deleted: false, sizeBytes: 0 };
    try {
      await unlink(this.blobPath(sha256));
      await rmdir(join(this.blobsRoot, sha256.slice(0, 2))).catch((error) => {
        if (!["ENOTEMPTY", "ENOENT"].includes(nodeErrorCode(error) ?? "")) {
          throw error;
        }
      });
      return { deleted: true, sizeBytes: blob.sizeBytes };
    } catch (error) {
      if (nodeErrorCode(error) === "ENOENT") {
        return { deleted: false, sizeBytes: 0 };
      }
      if (isAttachmentError(error)) throw error;
      throw new AttachmentError(
        "attachment_storage_failed",
        "failed to delete attachment bytes",
        true,
      );
    }
  }

  async recoverStaging(
    options: RecoverStagingOptions,
  ): Promise<RecoverStagingResult> {
    await this.initialize();
    const removed: string[] = [];
    const retained: string[] = [];
    const recoverable: string[] = [];
    const entries = await readdir(this.stagingRoot, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (!entry.name.endsWith(".part") || !entry.isFile()) {
        retained.push(entry.name);
        continue;
      }
      if (options.activeNames.has(entry.name)) {
        retained.push(entry.name);
        recoverable.push(entry.name);
        continue;
      }
      const path = join(this.stagingRoot, entry.name);
      const stats = await lstat(path);
      if (stats.mtimeMs >= options.olderThan) {
        retained.push(entry.name);
        recoverable.push(entry.name);
        continue;
      }
      await unlink(path);
      removed.push(entry.name);
    }
    return { removed, retained, recoverable };
  }

  stagingCutoff(maxAgeMs: number): number {
    if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs < 0) {
      throw new AttachmentError(
        "attachment_invalid_request",
        "maxAgeMs must be a non-negative safe integer",
      );
    }
    return this.now() - maxAgeMs;
  }

  private blobPath(sha256: string): string {
    return join(this.blobsRoot, sha256.slice(0, 2), sha256);
  }
}

async function writeAll(handle: FileHandle, chunk: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const result = await handle.write(
      chunk,
      offset,
      chunk.byteLength - offset,
      null,
    );
    offset += result.bytesWritten;
  }
}

async function readWithAbort(
  reader: AttachmentStreamReader,
  signal?: AbortSignal,
): Promise<AttachmentStreamReadResult> {
  if (!signal) return reader.read();
  throwIfAborted(signal);
  let abort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    abort = () =>
      reject(
        new AttachmentError("attachment_aborted", "attachment upload aborted"),
      );
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([reader.read(), aborted]);
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
  }
}

type AttachmentStreamReadResult =
  | { done: false; value: Uint8Array }
  | { done: true; value?: Uint8Array };

interface AttachmentStreamReader {
  read(): Promise<AttachmentStreamReadResult>;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new AttachmentError("attachment_aborted", "attachment upload aborted");
  }
}

function validateUploadId(uploadId: string): void {
  if (!UPLOAD_ID_PATTERN.test(uploadId)) {
    throw new AttachmentError(
      "attachment_invalid_request",
      "uploadId contains unsupported characters",
    );
  }
}

function validateSha256(sha256: string): void {
  if (!SHA256_PATTERN.test(sha256)) {
    throw new AttachmentError(
      "attachment_invalid_request",
      "sha256 must be 64 lowercase hexadecimal characters",
    );
  }
}

function optionalNonNegativeSafeInteger(
  value: number | undefined,
  field: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AttachmentError(
      "attachment_invalid_request",
      `${field} must be a non-negative safe integer`,
    );
  }
  return value;
}

function nodeErrorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String(error.code)
    : undefined;
}

function attachmentBytesUnavailable(): AttachmentError {
  return new AttachmentError(
    "attachment_storage_failed",
    "attachment bytes are unavailable",
    true,
  );
}

function normalizeBlobReadErrors(
  source: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) controller.close();
        else controller.enqueue(result.value);
      } catch {
        controller.error(attachmentBytesUnavailable());
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => undefined);
    },
  });
}

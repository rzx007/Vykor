import { open, type FileHandle } from "node:fs/promises";
import { normalize, resolve } from "node:path";
import sharp from "sharp";

export const VISION_IMAGE_POLICY_VERSION = "vision-v1";
export const DEFAULT_MAX_VISION_SOURCE_BYTES = 20 * 1024 * 1024;
export const DEFAULT_MAX_VISION_BASE64_BYTES = 5 * 1024 * 1024;

const DEFAULT_MAX_SIDE = 2_000;
const DEFAULT_MAX_INPUT_PIXELS = 40_000_000;
const DEFAULT_IDLE_TTL_MS = 15 * 60 * 1_000;
const DEFAULT_MAX_ENTRIES = 32;
const DEFAULT_MAX_CACHE_BYTES = 64 * 1024 * 1024;
const SWEEP_INTERVAL_MS = 60_000;
const JPEG_QUALITIES = [85, 75, 60] as const;
const DIRECT_MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export type VisionImagePreparationErrorCode =
  | "source_too_large"
  | "invalid_image"
  | "output_too_large"
  | "aborted";

export class VisionImagePreparationError extends Error {
  constructor(
    public readonly code: VisionImagePreparationErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "VisionImagePreparationError";
  }
}

export interface PreparedVisionImage {
  base64: string;
  mediaType: string;
  width: number;
  height: number;
  encodedBytes: number;
  base64Bytes: number;
  policyVersion: string;
}

export interface VisionImagePreparerOptions {
  maxSourceBytes?: number;
  maxBase64Bytes?: number;
  maxSide?: number;
  maxInputPixels?: number;
  idleTtlMs?: number;
  maxEntries?: number;
  maxCacheBytes?: number;
  now?: () => number;
  onPrepare?: () => void | Promise<void>;
  closeHandle?: (handle: FileHandle) => Promise<void>;
}

interface CacheEntry {
  key: string;
  canonicalPath: string;
  value: PreparedVisionImage;
  lastUsedAt: number;
  accessOrder: number;
}

interface InFlightEntry {
  promise: Promise<PreparedVisionImage>;
  controller: AbortController;
  waiters: number;
  settled: boolean;
}

export class VisionImagePreparer {
  private readonly maxSourceBytes: number;
  private readonly maxBase64Bytes: number;
  private readonly maxSide: number;
  private readonly maxInputPixels: number;
  private readonly idleTtlMs: number;
  private readonly maxEntries: number;
  private readonly maxCacheBytes: number;
  private readonly now: () => number;
  private readonly onPrepare?: () => void | Promise<void>;
  private readonly closeHandle: (handle: FileHandle) => Promise<void>;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, InFlightEntry>();
  private totalCacheBytes = 0;
  private accessCounter = 0;
  private sweepTimer: NodeJS.Timeout | undefined;

  constructor(options: VisionImagePreparerOptions = {}) {
    this.maxSourceBytes = options.maxSourceBytes ?? DEFAULT_MAX_VISION_SOURCE_BYTES;
    this.maxBase64Bytes = options.maxBase64Bytes ?? DEFAULT_MAX_VISION_BASE64_BYTES;
    this.maxSide = options.maxSide ?? DEFAULT_MAX_SIDE;
    this.maxInputPixels = options.maxInputPixels ?? DEFAULT_MAX_INPUT_PIXELS;
    this.idleTtlMs = options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.maxCacheBytes = options.maxCacheBytes ?? DEFAULT_MAX_CACHE_BYTES;
    this.now = options.now ?? Date.now;
    this.onPrepare = options.onPrepare;
    this.closeHandle = options.closeHandle ?? ((handle) => handle.close());
  }

  get cacheEntryCount(): number {
    return this.cache.size;
  }

  get cacheBytes(): number {
    return this.totalCacheBytes;
  }

  get inFlightCount(): number {
    return this.inFlight.size;
  }

  async prepare(
    sourcePath: string,
    declaredMediaType: string,
    signal?: AbortSignal,
  ): Promise<PreparedVisionImage> {
    throwIfAborted(signal);
    const canonicalPath = canonicalizePath(sourcePath);
    const handle = await open(canonicalPath, "r");
    let handleOwnedByPreparation = false;
    try {
      throwIfAborted(signal);
      const sourceStat = await handle.stat();
      throwIfAborted(signal);
      if (sourceStat.size > this.maxSourceBytes) throw this.sourceTooLarge();

      const key = [
        canonicalPath,
        sourceStat.size,
        sourceStat.mtimeMs,
        declaredMediaType,
        VISION_IMAGE_POLICY_VERSION,
        this.maxSide,
        this.maxBase64Bytes,
      ].join("\0");
      const cached = this.cache.get(key);
      if (cached) {
        cached.lastUsedAt = this.now();
        cached.accessOrder = ++this.accessCounter;
        return cached.value;
      }
      const pending = this.inFlight.get(key);
      if (pending) {
        if (pending.controller.signal.aborted) {
          await awaitWithAbort(pending.promise.catch(() => undefined), signal);
          throwIfAborted(signal);
          return await this.prepare(sourcePath, declaredMediaType, signal);
        }
        return await this.waitForInFlight(pending, signal);
      }

      handleOwnedByPreparation = true;
      let handleClosed = false;
      const entry: InFlightEntry = {
        promise: undefined as unknown as Promise<PreparedVisionImage>,
        controller: new AbortController(),
        waiters: 0,
        settled: false,
      };
      entry.promise = this.prepareUncached(handle, entry.controller.signal)
        .then(async (value) => {
          await this.closeHandle(handle);
          handleClosed = true;
          throwIfAborted(entry.controller.signal);
          this.insertCache({
            key,
            canonicalPath,
            value,
            lastUsedAt: this.now(),
            accessOrder: ++this.accessCounter,
          });
          return value;
        })
        .finally(async () => {
          entry.settled = true;
          if (this.inFlight.get(key) === entry) this.inFlight.delete(key);
          if (!handleClosed) await this.closeHandle(handle);
        });
      this.inFlight.set(key, entry);
      return await this.waitForInFlight(entry, signal);
    } finally {
      if (!handleOwnedByPreparation) await this.closeHandle(handle);
    }
  }

  hasCachedPath(sourcePath: string): boolean {
    const canonicalPath = canonicalizePath(sourcePath);
    return [...this.cache.values()].some((entry) => entry.canonicalPath === canonicalPath);
  }

  sweepExpired(): void {
    const expiresBefore = this.now() - this.idleTtlMs;
    for (const [key, entry] of this.cache) {
      if (entry.lastUsedAt < expiresBefore) this.removeCacheEntry(key);
    }
    this.stopSweepTimerIfEmpty();
  }

  dispose(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
    this.cache.clear();
    this.totalCacheBytes = 0;
  }

  private async prepareUncached(
    handle: FileHandle,
    signal: AbortSignal,
  ): Promise<PreparedVisionImage> {
    await this.onPrepare?.();
    throwIfAborted(signal);
    try {
      const source = await readBounded(handle, this.maxSourceBytes, signal);
      throwIfAborted(signal);
      const metadata = await sharp(source, {
        animated: false,
        limitInputPixels: this.maxInputPixels,
      }).metadata();
      throwIfAborted(signal);
      const orientationSwapsSides = (metadata.orientation ?? 1) >= 5;
      const sourceWidth = orientationSwapsSides ? metadata.height : metadata.width;
      const sourceHeight = orientationSwapsSides ? metadata.width : metadata.height;
      if (!sourceWidth || !sourceHeight) {
        throw new VisionImagePreparationError("invalid_image", "Image dimensions are missing");
      }

      const detectedMediaType = mediaTypeFromSharpFormat(metadata.format);
      const base64Bytes = encodedToBase64Bytes(source.byteLength);
      const canPreserve = detectedMediaType !== undefined
        && DIRECT_MEDIA_TYPES.has(detectedMediaType)
        && (metadata.pages ?? 1) === 1
        && (metadata.orientation === undefined || metadata.orientation === 1)
        && sourceWidth <= this.maxSide
        && sourceHeight <= this.maxSide
        && base64Bytes <= this.maxBase64Bytes;
      if (canPreserve) {
        throwIfAborted(signal);
        return toPreparedResult(source, detectedMediaType, sourceWidth, sourceHeight);
      }

      let targetWidth = sourceWidth;
      let targetHeight = sourceHeight;
      if (Math.max(targetWidth, targetHeight) > this.maxSide) {
        const ratio = this.maxSide / Math.max(targetWidth, targetHeight);
        targetWidth = Math.max(1, Math.round(targetWidth * ratio));
        targetHeight = Math.max(1, Math.round(targetHeight * ratio));
      }

      while (targetWidth >= 1 && targetHeight >= 1) {
        throwIfAborted(signal);
        const pipeline = () => sharp(source, {
          animated: false,
          limitInputPixels: this.maxInputPixels,
        }).rotate().resize(targetWidth, targetHeight, {
          fit: "inside",
          withoutEnlargement: true,
        });

        const png = await pipeline().png().toBuffer({ resolveWithObject: true });
        throwIfAborted(signal);
        const pngResult = toPreparedResult(
          png.data,
          "image/png",
          png.info.width,
          png.info.height,
        );
        if (pngResult.base64Bytes <= this.maxBase64Bytes) return pngResult;

        for (const quality of JPEG_QUALITIES) {
          const jpeg = await pipeline()
            .flatten({ background: "#ffffff" })
            .jpeg({ quality })
            .toBuffer({ resolveWithObject: true });
          throwIfAborted(signal);
          const jpegResult = toPreparedResult(
            jpeg.data,
            "image/jpeg",
            jpeg.info.width,
            jpeg.info.height,
          );
          if (jpegResult.base64Bytes <= this.maxBase64Bytes) return jpegResult;
        }

        if (targetWidth === 1 && targetHeight === 1) break;
        targetWidth = Math.max(1, Math.floor(targetWidth * 0.75));
        targetHeight = Math.max(1, Math.floor(targetHeight * 0.75));
      }
    } catch (error) {
      if (error instanceof VisionImagePreparationError) throw error;
      if (signal.aborted) throw abortedError(signal.reason);
      throw new VisionImagePreparationError(
        "invalid_image",
        "The attachment is not a valid processable image",
        { cause: error },
      );
    }
    throw new VisionImagePreparationError(
      "output_too_large",
      `Vision image could not be reduced below ${this.maxBase64Bytes} base64 bytes`,
    );
  }

  private insertCache(entry: CacheEntry): void {
    if (entry.value.base64Bytes > this.maxCacheBytes || this.maxEntries <= 0) return;
    this.cache.set(entry.key, entry);
    this.totalCacheBytes += entry.value.base64Bytes;
    while (
      this.cache.size > this.maxEntries
      || this.totalCacheBytes > this.maxCacheBytes
    ) {
      const oldest = [...this.cache.values()].reduce((candidate, current) =>
        current.accessOrder < candidate.accessOrder ? current : candidate);
      this.removeCacheEntry(oldest.key);
    }
    if (this.cache.size > 0) this.startSweepTimer();
  }

  private removeCacheEntry(key: string): void {
    const entry = this.cache.get(key);
    if (!entry) return;
    this.totalCacheBytes -= entry.value.base64Bytes;
    this.cache.delete(key);
  }

  private startSweepTimer(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => this.sweepExpired(), SWEEP_INTERVAL_MS);
    this.sweepTimer.unref();
  }

  private stopSweepTimerIfEmpty(): void {
    if (this.cache.size > 0 || !this.sweepTimer) return;
    clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
  }

  private async waitForInFlight(
    entry: InFlightEntry,
    signal?: AbortSignal,
  ): Promise<PreparedVisionImage> {
    entry.waiters++;
    try {
      return await awaitWithAbort(entry.promise, signal);
    } finally {
      entry.waiters--;
      if (entry.waiters === 0 && !entry.settled) {
        entry.controller.abort();
      }
    }
  }

  private sourceTooLarge(): VisionImagePreparationError {
    return new VisionImagePreparationError(
      "source_too_large",
      `Vision image source exceeds ${this.maxSourceBytes} bytes`,
    );
  }
}

function toPreparedResult(
  bytes: Buffer,
  mediaType: string,
  width: number,
  height: number,
): PreparedVisionImage {
  const base64 = bytes.toString("base64");
  return {
    base64,
    mediaType,
    width,
    height,
    encodedBytes: bytes.byteLength,
    base64Bytes: Buffer.byteLength(base64),
    policyVersion: VISION_IMAGE_POLICY_VERSION,
  };
}

function encodedToBase64Bytes(encodedBytes: number): number {
  return 4 * Math.ceil(encodedBytes / 3);
}

function mediaTypeFromSharpFormat(format?: string): string | undefined {
  if (format === "jpeg") return "image/jpeg";
  if (format === "png") return "image/png";
  if (format === "webp") return "image/webp";
  if (format === "gif") return "image/gif";
  return undefined;
}

async function readBounded(
  handle: FileHandle,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  while (total <= maxBytes) {
    throwIfAborted(signal);
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total));
    const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, null);
    throwIfAborted(signal);
    if (bytesRead === 0) return Buffer.concat(chunks, total);
    chunks.push(chunk.subarray(0, bytesRead));
    total += bytesRead;
  }
  throw new VisionImagePreparationError(
    "source_too_large",
    `Vision image source exceeds ${maxBytes} bytes`,
  );
}

function awaitWithAbort<T>(task: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return task;
  if (signal.aborted) return Promise.reject(abortedError(signal.reason));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortedError(signal.reason));
    signal.addEventListener("abort", onAbort, { once: true });
    void task.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

function canonicalizePath(path: string): string {
  const canonical = normalize(resolve(path));
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortedError(signal.reason);
}

function abortedError(reason: unknown): VisionImagePreparationError {
  return new VisionImagePreparationError(
    "aborted",
    "Vision image preparation was aborted",
    { cause: reason },
  );
}

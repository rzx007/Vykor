import { createHash, randomUUID } from "node:crypto";

import type { AttachmentRepresentationRecord } from "@openharness/protocol";

import type { NormalizedOcrImage } from "./image-normalizer.js";
import { normalizeOcrImage } from "./image-normalizer.js";
import type { LightOcrEngine, LightOcrRecognition } from "./light-ocr-engine.js";
import { normalizeLocalOcrError } from "./local-ocr-errors.js";

export const LOCAL_OCR_PROCESSOR = "light-ocr";
export const LOCAL_OCR_PROCESSOR_VERSION = "0.5.7";
export const OCR_NORMALIZATION_VERSION = "sharp-png-v1";

export interface LocalOcrAsset {
  assetId: string;
  sha256: string;
  mediaType: string;
  sizeBytes: number;
  bytes: Uint8Array;
}

export interface LocalOcrRepresentationRepository {
  findCompleted(assetId: string, cacheKey: string): AttachmentRepresentationRecord | undefined;
  begin(input: Omit<AttachmentRepresentationRecord, "status" | "metadata" | "createdAt" | "updatedAt">): AttachmentRepresentationRecord;
  complete(id: string, output: { text: string; metadata: Record<string, unknown> }): AttachmentRepresentationRecord;
  fail(id: string, error: string): void;
}

export interface LocalOcrRequest {
  assetId: string;
  locale?: string;
  signal?: AbortSignal;
}

export interface LocalOcrResult {
  status: "completed" | "no_text_detected";
  text: string;
  lines: readonly unknown[];
  representationId: string;
  processor: typeof LOCAL_OCR_PROCESSOR;
  processorVersion: typeof LOCAL_OCR_PROCESSOR_VERSION;
  cached: boolean;
  lineCount: number;
  durationMs: number;
}

export interface LocalOcrServiceOptions {
  resolveAsset(assetId: string, signal?: AbortSignal): Promise<LocalOcrAsset>;
  repository: LocalOcrRepresentationRepository;
  engine: Pick<LightOcrEngine, "recognize" | "close">;
  normalize?: (bytes: Uint8Array, mediaType: string) => Promise<NormalizedOcrImage>;
  id?: () => string;
  now?: () => number;
}

export class LocalOcrService {
  private readonly inflight = new Map<string, Promise<LocalOcrResult>>();
  private readonly normalize: NonNullable<LocalOcrServiceOptions["normalize"]>;
  private readonly id: () => string;
  private readonly now: () => number;

  constructor(private readonly options: LocalOcrServiceOptions) {
    this.normalize = options.normalize ?? normalizeOcrImage;
    this.id = options.id ?? (() => `rep_${randomUUID()}`);
    this.now = options.now ?? Date.now;
  }

  async recognize(request: LocalOcrRequest): Promise<LocalOcrResult> {
    request.signal?.throwIfAborted();
    const asset = await this.options.resolveAsset(request.assetId, request.signal);
    const cacheKey = buildLocalOcrCacheKey(asset.sha256, request.locale);
    const cached = this.options.repository.findCompleted(asset.assetId, cacheKey);
    if (cached) return fromRecord(cached, true);
    const key = `${asset.assetId}:${cacheKey}`;
    const existing = this.inflight.get(key);
    if (existing) return await existing;
    const work = this.run(asset, cacheKey, request);
    this.inflight.set(key, work);
    try { return await work; } finally { this.inflight.delete(key); }
  }

  close(): Promise<void> {
    return this.options.engine.close();
  }

  private async run(asset: LocalOcrAsset, cacheKey: string, request: LocalOcrRequest): Promise<LocalOcrResult> {
    const id = this.id();
    const record = this.options.repository.begin({
      id,
      assetId: asset.assetId,
      kind: "ocr_text",
      processor: LOCAL_OCR_PROCESSOR,
      processorVersion: LOCAL_OCR_PROCESSOR_VERSION,
      cacheKey,
      mediaType: "text/plain",
    });
    const startedAt = this.now();
    try {
      const normalized = await this.normalize(asset.bytes, asset.mediaType);
      request.signal?.throwIfAborted();
      const result = await this.recognizeWithOneRetry(normalized, request);
      const lines = result.lines.filter((line) => line.text.trim().length > 0);
      const text = lines.map((line) => line.text).join("\n").slice(0, 100_000);
      const durationMs = Math.max(0, this.now() - startedAt);
      const completed = this.options.repository.complete(record.id, {
        text,
        metadata: {
          status: lines.length === 0 ? "no_text_detected" : "completed",
          lines,
          timing: result.timing,
          modelProfile: result.modelProfile,
          locale: request.locale ?? "auto",
          width: normalized.width,
          height: normalized.height,
          normalized: normalized.normalized,
          normalizationVersion: OCR_NORMALIZATION_VERSION,
          durationMs,
        },
      });
      return fromRecord(completed, false);
    } catch (error) {
      const normalized = normalizeLocalOcrError(error);
      this.options.repository.fail(record.id, normalized.code);
      throw normalized;
    }
  }

  private async recognizeWithOneRetry(
    normalized: NormalizedOcrImage,
    request: LocalOcrRequest,
  ): Promise<LightOcrRecognition> {
    const options = { signal: request.signal, applyExif: !normalized.normalized };
    try {
      return await this.options.engine.recognize(normalized.bytes, options) as LightOcrRecognition;
    } catch (error) {
      const failure = normalizeLocalOcrError(error);
      if (failure.code !== "ocr_inference_failed" || !failure.retryable) throw failure;
      request.signal?.throwIfAborted();
      return await this.options.engine.recognize(normalized.bytes, options) as LightOcrRecognition;
    }
  }
}

export function buildLocalOcrCacheKey(sha256: string, locale = "auto"): string {
  return createHash("sha256").update(JSON.stringify({
    sha256,
    kind: "ocr_text",
    processor: LOCAL_OCR_PROCESSOR,
    processorVersion: LOCAL_OCR_PROCESSOR_VERSION,
    modelProfile: "small",
    locale,
    normalizationVersion: OCR_NORMALIZATION_VERSION,
  })).digest("hex");
}

function fromRecord(record: AttachmentRepresentationRecord, cached: boolean): LocalOcrResult {
  const lines = Array.isArray(record.metadata.lines) ? record.metadata.lines : [];
  const status = record.metadata.status === "no_text_detected" ? "no_text_detected" : "completed";
  return {
    status,
    text: record.text ?? "",
    lines,
    representationId: record.id,
    processor: LOCAL_OCR_PROCESSOR,
    processorVersion: LOCAL_OCR_PROCESSOR_VERSION,
    cached,
    lineCount: lines.length,
    durationMs: typeof record.metadata.durationMs === "number" ? record.metadata.durationMs : 0,
  };
}

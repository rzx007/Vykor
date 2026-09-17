import { describe, expect, it, vi } from "vitest";

import {
  LocalOcrService,
  type LocalOcrRepresentationRepository,
} from "../local-ocr-service.js";
import { LocalOcrError } from "../local-ocr-errors.js";

describe("LocalOcrService", () => {
  it("caches completed OCR by asset hash and processor inputs", async () => {
    const records = new Map<string, any>();
    const repository: LocalOcrRepresentationRepository = {
      findCompleted: (assetId, cacheKey) =>
        [...records.values()].find((item) => item.assetId === assetId && item.cacheKey === cacheKey && item.status === "completed"),
      begin: (input) => {
        const record = { ...input, status: "running", metadata: {}, createdAt: 1, updatedAt: 1 };
        records.set(record.id, record);
        return record;
      },
      complete: (id, output) => {
        const record = { ...records.get(id), ...output, status: "completed", updatedAt: 2 };
        records.set(id, record);
        return record;
      },
      fail: (id, error) => {
        records.set(id, { ...records.get(id), status: "failed", error });
      },
    };
    const recognize = vi.fn(async () => ({
      lines: [{
        text: "总计 42.00",
        confidence: 0.98,
        box: [{ x: 1, y: 2 }, { x: 3, y: 2 }, { x: 3, y: 4 }, { x: 1, y: 4 }],
      }],
      timing: { totalMs: 7 },
      modelProfile: "small",
    }));
    const service = new LocalOcrService({
      resolveAsset: async () => ({
        assetId: "att-1",
        sha256: "a".repeat(64),
        mediaType: "image/png",
        sizeBytes: 8,
        bytes: new Uint8Array([137, 80, 78, 71]),
      }),
      repository,
      engine: { recognize, close: async () => undefined },
      normalize: async (bytes, mediaType) => ({
        bytes,
        mediaType,
        width: 2,
        height: 2,
        normalized: false,
      }),
      id: () => "rep-1",
      now: () => 100,
    });

    const first = await service.recognize({ assetId: "att-1", locale: "zh-CN" });
    const second = await service.recognize({ assetId: "att-1", locale: "zh-CN" });

    expect(first).toMatchObject({
      status: "completed",
      text: "总计 42.00",
      representationId: "rep-1",
      cached: false,
      processor: "light-ocr",
      processorVersion: "0.5.7",
    });
    expect(second.cached).toBe(true);
    expect(recognize).toHaveBeenCalledTimes(1);
  });

  it("treats zero lines as a successful no_text_detected result", async () => {
    const repository = memoryRepository();
    const service = new LocalOcrService({
      resolveAsset: async () => ({
        assetId: "empty",
        sha256: "b".repeat(64),
        mediaType: "image/jpeg",
        sizeBytes: 2,
        bytes: new Uint8Array([1, 2]),
      }),
      repository,
      engine: {
        recognize: async () => ({ lines: [], timing: { totalMs: 2 }, modelProfile: "small" }),
        close: async () => undefined,
      },
      normalize: async (bytes, mediaType) => ({ bytes, mediaType, width: 1, height: 1, normalized: false }),
      id: () => "rep-empty",
    });

    await expect(service.recognize({ assetId: "empty" })).resolves.toMatchObject({
      status: "no_text_detected",
      text: "",
      lineCount: 0,
      cached: false,
    });
  });

  it("retries one transient inference failure inside the same representation", async () => {
    const repository = memoryRepository();
    const recognize = vi.fn()
      .mockRejectedValueOnce(new LocalOcrError("ocr_inference_failed", "worker busy", true))
      .mockResolvedValueOnce({
        lines: [{ text: "retry worked", confidence: 0.9, box: [] }],
        timing: { totalMs: 3 },
        modelProfile: "small",
      });
    const service = new LocalOcrService({
      resolveAsset: async () => ({
        assetId: "retry",
        sha256: "c".repeat(64),
        mediaType: "image/png",
        sizeBytes: 2,
        bytes: new Uint8Array([1, 2]),
      }),
      repository,
      engine: { recognize, close: async () => undefined },
      normalize: async (bytes, mediaType) => ({ bytes, mediaType, width: 1, height: 1, normalized: false }),
      id: () => "rep-retry",
    });

    await expect(service.recognize({ assetId: "retry" })).resolves.toMatchObject({
      text: "retry worked",
      representationId: "rep-retry",
    });
    expect(recognize).toHaveBeenCalledTimes(2);
  });
});

function memoryRepository(): LocalOcrRepresentationRepository {
  const records = new Map<string, any>();
  return {
    findCompleted: (assetId, cacheKey) => [...records.values()].find((item) => item.assetId === assetId && item.cacheKey === cacheKey && item.status === "completed"),
    begin: (input) => {
      const record = { ...input, status: "running", metadata: {}, createdAt: 1, updatedAt: 1 };
      records.set(record.id, record);
      return record;
    },
    complete: (id, output) => {
      const record = { ...records.get(id), ...output, status: "completed", updatedAt: 2 };
      records.set(id, record);
      return record;
    },
    fail: (id, error) => { records.set(id, { ...records.get(id), status: "failed", error }); },
  };
}

import { describe, expect, it, vi } from "vitest";

import { LightOcrEngine } from "../light-ocr-engine.js";

describe("LightOcrEngine", () => {
  it("reuses one engine and closes it exactly once", async () => {
    const close = vi.fn(async () => undefined);
    const recognizeEncoded = vi.fn(async () => ({ lines: [], timing: { totalMs: 3 } }));
    const createEngine = vi.fn(async () => ({
      recognizeEncoded,
      close,
      info: { model: { profile: "small" } },
    }));
    const engine = new LightOcrEngine({ createEngine, queueCapacity: 2 });

    await Promise.all([
      engine.recognize(new Uint8Array([1]), {}),
      engine.recognize(new Uint8Array([2]), {}),
    ]);
    await engine.close();
    await engine.close();

    expect(createEngine).toHaveBeenCalledTimes(1);
    expect(recognizeEncoded).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledTimes(1);
    await expect(engine.recognize(new Uint8Array([3]), {})).rejects.toMatchObject({
      code: "ocr_service_closed",
    });
  });

  it("falls back to the CPU provider when the default engine creation fails", async () => {
    const recognizeEncoded = vi.fn(async () => ({ lines: [], timing: { totalMs: 1 } }));
    const createEngine = vi.fn(async (options: { execution?: { provider?: string } }) => {
      if (options.execution?.provider !== "cpu") {
        throw new Error("ONNX Runtime WebGPU provider setup failed");
      }
      return { recognizeEncoded, close: async () => undefined, info: {} };
    });
    const engine = new LightOcrEngine({
      loadLibrary: async () => ({ createEngine }),
      queueCapacity: 1,
    });

    await expect(engine.recognize(new Uint8Array([1]), {})).resolves.toMatchObject({ lines: [] });
    expect(createEngine).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ bundlePath: expect.any(String) }),
    );
    expect(createEngine).toHaveBeenLastCalledWith(
      expect.objectContaining({ execution: { provider: "cpu" } }),
    );
    await engine.close();
  });

  it("retries engine creation after a failure instead of caching the rejection", async () => {
    const recognizeEncoded = vi.fn(async () => ({ lines: [], timing: { totalMs: 1 } }));
    const createEngine = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient engine creation failure"))
      .mockResolvedValue({ recognizeEncoded, close: async () => undefined, info: {} });
    const engine = new LightOcrEngine({ createEngine, queueCapacity: 1 });

    await expect(engine.recognize(new Uint8Array([1]), {})).rejects.toThrow(
      "transient engine creation failure",
    );
    await expect(engine.recognize(new Uint8Array([2]), {})).resolves.toMatchObject({ lines: [] });
    expect(createEngine).toHaveBeenCalledTimes(2);
    await engine.close();
  });

  it("cancels a queued request without starting recognition", async () => {
    let release!: () => void;
    const first = new Promise<void>((resolve) => { release = resolve; });
    const recognizeEncoded = vi.fn(async () => {
      await first;
      return { lines: [], timing: { totalMs: 1 } };
    });
    const engine = new LightOcrEngine({
      createEngine: async () => ({ recognizeEncoded, close: async () => undefined, info: {} }),
      queueCapacity: 1,
    });
    const running = engine.recognize(new Uint8Array([1]), {});
    const controller = new AbortController();
    const queued = engine.recognize(new Uint8Array([2]), { signal: controller.signal });
    controller.abort(new Error("stop"));

    await expect(queued).rejects.toMatchObject({ code: "ocr_cancelled" });
    release();
    await running;
    expect(recognizeEncoded).toHaveBeenCalledTimes(1);
    await engine.close();
  });
});


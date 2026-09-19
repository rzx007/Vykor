import type { OcrEngine, OcrResult, RecognizeOptions } from "@arcships/light-ocr";
import { existsSync } from "node:fs";
import { createRequire as createNodeRequire } from "node:module";
import { dirname } from "node:path";

import { LocalOcrError, normalizeLocalOcrError } from "./local-ocr-errors.js";

type EngineLike = Pick<OcrEngine, "recognizeEncoded" | "close"> & { readonly info: unknown };

export interface LightOcrEngineLibrary {
  createEngine(options: {
    queueCapacity: number;
    bundlePath: string;
    execution?: { provider: "cpu" };
  }): Promise<EngineLike>;
}

export interface LightOcrEngineOptions {
  createEngine?: () => Promise<EngineLike>;
  loadLibrary?: () => Promise<LightOcrEngineLibrary>;
  queueCapacity?: number;
}

export interface LightOcrRecognition {
  lines: OcrResult["lines"];
  timing: OcrResult["timingUs"] | { totalMs: number };
  modelProfile: string;
  imageWidth?: number;
  imageHeight?: number;
}

export class LightOcrEngine {
  private enginePromise?: Promise<EngineLike>;
  private active = false;
  private readonly waiting: Array<{
    bytes: Uint8Array;
    options: RecognizeOptions;
    resolve(value: LightOcrRecognition): void;
    reject(error: unknown): void;
    cleanup(): void;
  }> = [];
  private closed = false;
  private closePromise?: Promise<void>;
  private readonly createEngine: () => Promise<EngineLike>;
  private readonly queueCapacity: number;

  constructor(options: LightOcrEngineOptions = {}) {
    this.queueCapacity = options.queueCapacity ?? 4;
    this.createEngine = options.createEngine ?? (async () => {
      const library = await (options.loadLibrary ?? loadLightOcrLibrary)();
      const bundlePath = resolveBundledModelPath();
      try {
        return await library.createEngine({ queueCapacity: this.queueCapacity, bundlePath });
      } catch (error) {
        // The desktop daemon runs inside Electron's main process, where the
        // default GPU (WebGPU/Dawn) provider cannot initialize. The CPU
        // provider is always available, so retry once with it.
        try {
          return await library.createEngine({
            queueCapacity: this.queueCapacity,
            bundlePath,
            execution: { provider: "cpu" },
          });
        } catch {
          throw error;
        }
      }
    });
  }

  recognize(bytes: Uint8Array, options: RecognizeOptions): Promise<LightOcrRecognition> {
    if (this.closed) return Promise.reject(new LocalOcrError("ocr_service_closed", "OCR service is closed"));
    if (options.signal?.aborted) return Promise.reject(new LocalOcrError("ocr_cancelled", "OCR was cancelled"));
    if (this.waiting.length >= this.queueCapacity) {
      return Promise.reject(new LocalOcrError("ocr_queue_full", "The local OCR queue is full", true));
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const abort = () => {
        const index = this.waiting.indexOf(item);
        if (index >= 0) this.waiting.splice(index, 1);
        if (!settled) reject(new LocalOcrError("ocr_cancelled", "OCR was cancelled"));
        settled = true;
      };
      const cleanup = () => options.signal?.removeEventListener("abort", abort);
      const item = { bytes, options, resolve, reject, cleanup };
      options.signal?.addEventListener("abort", abort, { once: true });
      this.waiting.push(item);
      void this.pump();
    });
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    const error = new LocalOcrError("ocr_service_closed", "OCR service is closed");
    for (const item of this.waiting.splice(0)) {
      item.cleanup();
      item.reject(error);
    }
    this.closePromise = (async () => {
      const engine = await this.enginePromise?.catch(() => undefined);
      await engine?.close();
    })();
    return this.closePromise;
  }

  private async acquireEngine(): Promise<EngineLike> {
    this.enginePromise ??= this.createEngine();
    try {
      return await this.enginePromise;
    } catch (error) {
      // Do not cache a rejected creation: a transient failure must not disable
      // OCR for the rest of the process lifetime.
      this.enginePromise = undefined;
      throw error;
    }
  }

  private async pump(): Promise<void> {
    if (this.active || this.closed) return;
    const item = this.waiting.shift();
    if (!item) return;
    this.active = true;
    try {
      if (item.options.signal?.aborted) throw new LocalOcrError("ocr_cancelled", "OCR was cancelled");
      const engine = await this.acquireEngine();
      const result = await engine.recognizeEncoded(item.bytes, item.options) as OcrResult;
      const info = engine.info as { model?: { profile?: string }; modelBundleId?: string };
      item.resolve({
        lines: result.lines,
        timing: result.timingUs ?? { totalMs: 0 },
        modelProfile: info.model?.profile ?? info.modelBundleId ?? "small",
        imageWidth: result.imageWidth,
        imageHeight: result.imageHeight,
      });
    } catch (error) {
      item.reject(normalizeLocalOcrError(error));
    } finally {
      item.cleanup();
      this.active = false;
      void this.pump();
    }
  }
}

async function loadLightOcrLibrary(): Promise<LightOcrEngineLibrary> {
  return await import("@arcships/light-ocr");
}

function resolveBundledModelPath(): string {
  const require = createNodeRequire(import.meta.url);
  const lightOcrEntry = require.resolve("@arcships/light-ocr");
  const fromLightOcr = createNodeRequire(lightOcrEntry);
  const manifest = fromLightOcr.resolve(
    "@arcships/light-ocr-model-ppocrv6-small/bundle/manifest.json",
  );
  let bundlePath = dirname(manifest);
  const unpacked = bundlePath.replace(/([\\/])app\.asar([\\/])/, "$1app.asar.unpacked$2");
  if (unpacked !== bundlePath && existsSync(unpacked)) bundlePath = unpacked;
  // light-ocr validates every bundled platform directory. Deep model paths can
  // exceed Win32's legacy 260-character boundary in pnpm worktrees or Program
  // Files; the extended-length prefix keeps that validation on the same files.
  if (process.platform === "win32" && !bundlePath.startsWith("\\\\?\\")) {
    return `\\\\?\\${bundlePath}`;
  }
  return bundlePath;
}

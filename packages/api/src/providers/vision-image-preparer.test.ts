import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  VisionImagePreparationError,
  VisionImagePreparer,
} from "./vision-image-preparer.js";

const tempDirectories: string[] = [];

async function tempFile(name: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "vykor-vision-"));
  tempDirectories.push(directory);
  return join(directory, name);
}

function twoFrameGif(): Buffer {
  return Buffer.from([
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61,
    0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00,
    0x00, 0x00, 0x00, 0xff, 0xff, 0xff,
    0x21, 0xf9, 0x04, 0x00, 0x0a, 0x00, 0x00, 0x00,
    0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0x02, 0x02, 0x44, 0x01, 0x00,
    0x21, 0xf9, 0x04, 0x00, 0x0a, 0x00, 0x00, 0x00,
    0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0x02, 0x02, 0x4c, 0x01, 0x00,
    0x3b,
  ]);
}

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })));
});

describe("VisionImagePreparer", () => {
  it("preserves compliant JPEG bytes and reports canonical metadata", async () => {
    const path = await tempFile("small.jpg");
    const original = await sharp({
      create: { width: 320, height: 200, channels: 3, background: "#345678" },
    }).jpeg({ quality: 90 }).toBuffer();
    await writeFile(path, original);
    const preparer = new VisionImagePreparer();

    const result = await preparer.prepare(path, "image/jpeg");

    expect(Buffer.from(result.base64, "base64")).toEqual(original);
    expect(result).toMatchObject({
      mediaType: "image/jpeg",
      width: 320,
      height: 200,
      encodedBytes: original.byteLength,
      base64Bytes: Buffer.byteLength(original.toString("base64")),
    });
  });

  it("applies orientation and limits the longest side to 2000px", async () => {
    const path = await tempFile("rotated.jpg");
    await sharp({
      create: { width: 3000, height: 1200, channels: 3, background: "#abcdef" },
    }).jpeg().withMetadata({ orientation: 6 }).toFile(path);
    const preparer = new VisionImagePreparer();

    const result = await preparer.prepare(path, "image/jpeg");

    expect(result.width).toBe(800);
    expect(result.height).toBe(2000);
    const metadata = await sharp(Buffer.from(result.base64, "base64")).metadata();
    expect(metadata.orientation).toBeUndefined();
  });

  it("uses the quality and size ladder until base64 fits the configured limit", async () => {
    const path = await tempFile("noise.png");
    const noise = Buffer.allocUnsafe(1600 * 1200 * 3);
    let random = 0x12345678;
    for (let index = 0; index < noise.length; index++) {
      random ^= random << 13;
      random ^= random >>> 17;
      random ^= random << 5;
      noise[index] = random & 0xff;
    }
    await sharp(noise, { raw: { width: 1600, height: 1200, channels: 3 } }).png().toFile(path);
    const preparer = new VisionImagePreparer({ maxBase64Bytes: 12_000 });

    const result = await preparer.prepare(path, "image/png");

    expect(result.base64Bytes).toBeLessThanOrEqual(12_000);
    expect(result.mediaType).toBe("image/jpeg");
    expect(result.width).toBeLessThanOrEqual(1600);
    expect(result.height).toBeLessThanOrEqual(1200);
  });

  it("reads only the first frame of animated input", async () => {
    const path = await tempFile("animated.webp");
    const animated = await sharp(twoFrameGif(), { animated: true }).webp().toBuffer();
    expect((await sharp(animated, { animated: true }).metadata()).pages).toBe(2);
    await writeFile(path, animated);
    const preparer = new VisionImagePreparer();

    const result = await preparer.prepare(path, "image/webp");

    expect(result).toMatchObject({ width: 1, height: 1, mediaType: "image/png" });
    expect((await sharp(Buffer.from(result.base64, "base64"), { animated: true }).metadata()).pages)
      .toBeUndefined();
  });

  it("rejects oversized source files before decoding and rejects damaged images", async () => {
    const oversizedPath = await tempFile("oversized.png");
    await writeFile(oversizedPath, Buffer.alloc(101));
    const limited = new VisionImagePreparer({ maxSourceBytes: 100 });
    await expect(limited.prepare(oversizedPath, "image/png")).rejects.toMatchObject({
      code: "source_too_large",
    });

    const damagedPath = await tempFile("damaged.png");
    await writeFile(damagedPath, "not an image");
    await expect(new VisionImagePreparer().prepare(damagedPath, "image/png"))
      .rejects.toBeInstanceOf(VisionImagePreparationError);
  });

  it("rejects a file that grows beyond the source limit after stat", async () => {
    const path = await tempFile("growing.png");
    await writeFile(path, Buffer.alloc(50));
    const preparer = new VisionImagePreparer({
      maxSourceBytes: 100,
      onPrepare: async () => {
        await writeFile(path, Buffer.alloc(101));
      },
    });

    await expect(preparer.prepare(path, "image/png")).rejects.toMatchObject({
      code: "source_too_large",
    });
  });

  it("uses detected bytes instead of a mismatched declared MIME type", async () => {
    const path = await tempFile("actual.png");
    const png = await sharp({
      create: { width: 30, height: 20, channels: 3, background: "purple" },
    }).png().toBuffer();
    await writeFile(path, png);
    const onPrepare = vi.fn();
    const preparer = new VisionImagePreparer({ onPrepare });

    const result = await preparer.prepare(path, "image/jpeg");
    await preparer.prepare(path, "image/png");

    expect(result.mediaType).toBe("image/png");
    expect(Buffer.from(result.base64, "base64")).toEqual(png);
    expect(onPrepare).toHaveBeenCalledTimes(2);
  });

  it("deduplicates concurrent preparation and does not cache failures", async () => {
    const path = await tempFile("same.png");
    await sharp({
      create: { width: 100, height: 100, channels: 3, background: "green" },
    }).png().toFile(path);
    const onPrepare = vi.fn();
    const preparer = new VisionImagePreparer({ onPrepare });

    const [first, second] = await Promise.all([
      preparer.prepare(path, "image/png"),
      preparer.prepare(path, "image/png"),
    ]);
    await preparer.prepare(path, "image/png");

    expect(first).toBe(second);
    expect(onPrepare).toHaveBeenCalledOnce();

    const damagedPath = await tempFile("retry.png");
    await writeFile(damagedPath, "bad");
    await expect(preparer.prepare(damagedPath, "image/png")).rejects.toThrow();
    await expect(preparer.prepare(damagedPath, "image/png")).rejects.toThrow();
    expect(onPrepare).toHaveBeenCalledTimes(3);
  });

  it("keeps concurrent callers' cancellation independent", async () => {
    const path = await tempFile("cancel.png");
    await sharp({
      create: { width: 100, height: 50, channels: 3, background: "orange" },
    }).png().toFile(path);
    let release!: () => void;
    let markEntered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const preparer = new VisionImagePreparer({
      onPrepare: async () => {
        markEntered();
        await gate;
      },
    });
    const firstController = new AbortController();
    const secondController = new AbortController();

    const first = preparer.prepare(path, "image/png", firstController.signal);
    await entered;
    const second = preparer.prepare(path, "image/png");
    const third = preparer.prepare(path, "image/png", secondController.signal);
    firstController.abort(new Error("first cancelled"));
    secondController.abort(new Error("third cancelled"));
    release();

    await expect(first).rejects.toMatchObject({ code: "aborted" });
    await expect(third).rejects.toMatchObject({ code: "aborted" });
    await expect(second).resolves.toMatchObject({ width: 100, height: 50 });
  });

  it("aborts shared preparation when every waiter cancels and does not cache it", async () => {
    const path = await tempFile("all-cancel.png");
    await sharp({
      create: { width: 100, height: 50, channels: 3, background: "orange" },
    }).png().toFile(path);
    let release!: () => void;
    let markEntered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const preparer = new VisionImagePreparer({
      onPrepare: async () => {
        markEntered();
        await gate;
      },
    });
    const controller = new AbortController();
    const pending = preparer.prepare(path, "image/png", controller.signal);
    await entered;

    controller.abort();
    release();

    await expect(pending).rejects.toMatchObject({ code: "aborted" });
    await vi.waitFor(() => expect(preparer.inFlightCount).toBe(0));
    expect(preparer.cacheEntryCount).toBe(0);
  });

  it("starts fresh instead of joining an aborted in-flight preparation", async () => {
    const path = await tempFile("replace-aborted.png");
    await sharp({
      create: { width: 40, height: 20, channels: 3, background: "cyan" },
    }).png().toFile(path);
    let release!: () => void;
    let markEntered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    let attempts = 0;
    const preparer = new VisionImagePreparer({
      onPrepare: async () => {
        attempts++;
        if (attempts === 1) {
          markEntered();
          await gate;
        }
      },
    });
    const controller = new AbortController();
    const cancelled = preparer.prepare(path, "image/png", controller.signal);
    const cancelledResult = cancelled.catch((error: unknown) => error);
    await entered;
    controller.abort();
    const replacement = preparer.prepare(path, "image/png");
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();

    await expect(cancelledResult).resolves.toMatchObject({ code: "aborted" });
    await expect(replacement).resolves.toMatchObject({ width: 40, height: 20 });
    expect(attempts).toBe(2);
  });

  it("can cancel while waiting for an aborted in-flight entry to clean up", async () => {
    const path = await tempFile("cancel-cleanup-wait.png");
    await sharp({
      create: { width: 40, height: 20, channels: 3, background: "cyan" },
    }).png().toFile(path);
    let release!: () => void;
    let markEntered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const preparer = new VisionImagePreparer({
      onPrepare: async () => {
        markEntered();
        await gate;
      },
    });
    const firstController = new AbortController();
    const first = preparer.prepare(path, "image/png", firstController.signal);
    void first.catch(() => {});
    await entered;
    firstController.abort();
    const waitingController = new AbortController();
    const waiting = preparer.prepare(path, "image/png", waitingController.signal);
    await new Promise((resolve) => setTimeout(resolve, 20));
    waitingController.abort();

    const outcome = await Promise.race([
      waiting.catch((error: unknown) => error),
      new Promise((resolve) => setTimeout(() => resolve("timed out"), 100)),
    ]);
    release();
    await first.catch(() => {});
    expect(outcome).toMatchObject({ code: "aborted" });
  });

  it("does not publish cache entries when closing the source handle fails", async () => {
    const path = await tempFile("close-failure.png");
    await sharp({
      create: { width: 40, height: 20, channels: 3, background: "navy" },
    }).png().toFile(path);
    const closeHandle = vi.fn()
      .mockRejectedValueOnce(new Error("close failed"))
      .mockImplementation((handle) => handle.close());
    const preparer = new VisionImagePreparer({ closeHandle } as any);

    await expect(preparer.prepare(path, "image/png")).rejects.toThrow("close failed");
    expect(preparer.cacheEntryCount).toBe(0);
  });

  it("refreshes sliding TTL and evicts least-recently-used entries by capacity", async () => {
    let now = 0;
    const preparer = new VisionImagePreparer({
      now: () => now,
      idleTtlMs: 100,
      maxEntries: 2,
      maxCacheBytes: 1_000_000,
    });
    const paths = await Promise.all(["red.png", "green.png", "blue.png"].map(async (name) => {
      const path = await tempFile(name);
      await sharp({
        create: { width: 20, height: 20, channels: 3, background: name.slice(0, -4) },
      }).png().toFile(path);
      return path;
    }));

    await preparer.prepare(paths[0]!, "image/png");
    now = 50;
    await preparer.prepare(paths[0]!, "image/png");
    now = 60;
    await preparer.prepare(paths[1]!, "image/png");
    now = 75;
    await preparer.prepare(paths[2]!, "image/png");

    expect(preparer.cacheEntryCount).toBe(2);
    expect(preparer.hasCachedPath(paths[0]!)).toBe(false);
    now = 161;
    preparer.sweepExpired();
    expect(preparer.cacheEntryCount).toBe(1);
    now = 176;
    preparer.sweepExpired();
    expect(preparer.cacheEntryCount).toBe(0);
  });

  it("enforces the cache byte limit", async () => {
    const path = await tempFile("bytes.png");
    await sharp({
      create: { width: 50, height: 50, channels: 3, background: "blue" },
    }).png().toFile(path);
    const fileBytes = (await readFile(path)).byteLength;
    const preparer = new VisionImagePreparer({ maxCacheBytes: fileBytes - 1 });

    await preparer.prepare(path, "image/png");

    expect(preparer.cacheEntryCount).toBe(0);
    expect(preparer.cacheBytes).toBe(0);
  });
});

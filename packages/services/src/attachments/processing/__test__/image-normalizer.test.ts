import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { normalizeOcrImage } from "../image-normalizer.js";

describe("normalizeOcrImage", () => {
  it("keeps PNG encoded bytes and reports trusted dimensions", async () => {
    const bytes = await sharp({
      create: { width: 4, height: 3, channels: 4, background: "white" },
    }).png().toBuffer();
    const result = await normalizeOcrImage(bytes, "image/png");

    expect(result.mediaType).toBe("image/png");
    expect(result.width).toBe(4);
    expect(result.height).toBe(3);
    expect(result.bytes).toEqual(new Uint8Array(bytes));
    expect(result.normalized).toBe(false);
  });

  it("converts WebP to a single bounded PNG frame", async () => {
    const bytes = await sharp({
      create: { width: 5, height: 2, channels: 4, background: "black" },
    }).webp().toBuffer();
    const result = await normalizeOcrImage(bytes, "image/webp");
    const metadata = await sharp(result.bytes).metadata();

    expect(result.mediaType).toBe("image/png");
    expect(result.normalized).toBe(true);
    expect(metadata.format).toBe("png");
    expect(metadata.pages ?? 1).toBe(1);
  });

  it("rejects images above the pixel budget before OCR", async () => {
    const bytes = await sharp({
      create: { width: 20, height: 20, channels: 3, background: "white" },
    }).jpeg().toBuffer();

    await expect(normalizeOcrImage(bytes, "image/jpeg", { maxPixels: 399 }))
      .rejects.toMatchObject({ code: "ocr_resource_limit_exceeded" });
  });
});

